"""可选依赖的能力探测与按需安装（V15）

背景：人声分离 / 旋律这些功能依赖 torch（6 GB）、torchcrepe 等重型包。
把它们塞进源码树后果：
  - 仓库/安装包巨大（backend/vendor 现在 7 GB）
  - 新用户为了听歌被迫下载几个 GB，而他可能根本不用分离功能

方案：
  - 依赖**不放在源码树**，统一装到 `%LOCALAPPDATA%\\Haizhe\\deps`
  - 启动只做"能力探测"（不 import，只用 importlib 找包），缺什么就置灰
  - 用户要用某功能时，界面上点「安装」，后台跑 pip（带进度），装完即生效

兼容：老机器如果 `backend/vendor` 已存在，仍然优先生效（不强制迁移）。
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent

# ① 新位置（按需安装到这里）
if os.name == "nt":
    DEPS_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Haizhe" / "deps"
else:
    DEPS_DIR = Path.home() / ".local" / "share" / "haizhe" / "deps"

# ② 老位置（历史上 pip --target 到 backend/vendor，继续认）
LEGACY_DIR = BACKEND / "vendor"

MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
PROJECT_ROOT = BACKEND.parent

# 功能 → (展示名, 说明, 需要的包)
FEATURES = {
    "stems": {
        "name": "人声 / 伴奏分离",
        "desc": "分离出人声轨后，旋律功能才能算准；也用于「效果 → 音轨」",
        "packages": ["torch", "audio-separator", "imageio-ffmpeg"],
        "heavy": True,
    },
    "melody": {
        "name": "旋律（音高走向图）",
        "desc": "librosa 必需；torchcrepe 是加速项（装了走 CREPE 23 秒，没装退化 pyin 140 秒）",
        "packages": ["librosa", "torchcrepe"],
        "required": ["librosa"],          # torchcrepe 缺失不阻塞，只是慢
        "heavy": True,
    },
    "pinyin": {
        "name": "拼音搜索",
        "desc": "全拼 / 首字母检索（zjl → 周杰伦）",
        "packages": ["pypinyin"],
        "heavy": False,
    },
    # ── Node 侧组件：npm 装回项目 node_modules ──
    # 为什么应用内还补得了：浏览器版（start.bat）不依赖 Electron，所以
    # "前端能跑但桌面模式缺 electron.exe"是真实存在的状态。
    "desktop": {
        "name": "桌面模式（Electron）",
        "desc": "双击快捷方式启动 + 桌面歌词悬浮窗；不装也能用浏览器版",
        "kind": "npm",
        "packages": ["electron"],
        "check": ["node_modules/electron/dist/electron.exe"],
        "size_hint": "约 120MB",
        "where": "项目 node_modules",
        "heavy": False,
    },
}


def ensure_path() -> list[str]:
    """把依赖目录挂到 sys.path，返回实际生效的目录列表"""
    used = []
    for d in (DEPS_DIR, LEGACY_DIR):
        if d.is_dir() and str(d) not in sys.path:
            sys.path.insert(0, str(d))
        if d.is_dir():
            used.append(str(d))
    return used


def _installed(pkg: str) -> bool:
    """只探测位置，不执行包（import torch 要 2 秒，探测不该这么贵）"""
    name = pkg.replace("-", "_")
    if name in sys.modules:
        return True
    for d in (DEPS_DIR, LEGACY_DIR):
        if not d.is_dir():
            continue
        try:
            if importlib.util.find_spec(name) is not None:
                return True
        except Exception:
            pass
    # 有些包目录名和 import 名不同（audio-separator → audio_separator）
    for d in (DEPS_DIR, LEGACY_DIR):
        if (d / name).is_dir() or (d / pkg).is_dir():
            return True
    return False


def dir_size_mb(d: Path) -> float:
    if not d.is_dir():
        return 0.0
    total = 0
    for root, _dirs, files in os.walk(d):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return round(total / 1024 / 1024, 1)


def _applicable(meta: dict) -> bool:
    """这个组件在当前形态下是否存在意义。
    打包版没有 package.json（也不该改 node_modules），npm 组件直接不显示。"""
    if meta.get("kind") == "npm":
        return (PROJECT_ROOT / "package.json").exists()
    return True


def _feature_installed(meta: dict) -> bool:
    if meta.get("kind") == "npm":
        return all((PROJECT_ROOT / p).exists() for p in meta.get("check", []))
    ensure_path()
    need = meta.get("required") or meta["packages"]
    return all(_installed(p) for p in need)


def _feature_missing(meta: dict) -> tuple[list[str], list[str]]:
    """返回 (阻塞项, 可选缺项)"""
    if meta.get("kind") == "npm":
        miss = [] if _feature_installed(meta) else list(meta["packages"])
        return miss, []
    ensure_path()
    need = meta.get("required") or meta["packages"]
    miss_all = [p for p in meta["packages"] if not _installed(p)]
    blocking = [p for p in need if not _installed(p)]
    return blocking, [p for p in miss_all if p not in blocking]


def missing(feature: str) -> list[str]:
    """某个功能还缺哪些包（空列表 = 齐了）"""
    meta = FEATURES.get(feature)
    if not meta or not _applicable(meta):
        return []
    return _feature_missing(meta)[0]


def has(feature: str) -> bool:
    return not missing(feature)


def status() -> dict:
    ensure_path()
    feats = []
    for key, meta in FEATURES.items():
        if not _applicable(meta):
            continue
        blocking, optional = _feature_missing(meta)
        feats.append({
            "key": key,
            "name": meta["name"],
            "desc": meta["desc"],
            "heavy": meta["heavy"],
            "kind": meta.get("kind", "pip"),
            "where": meta.get("where", str(DEPS_DIR)),
            "size_hint": meta.get("size_hint", ""),
            "packages": meta["packages"],
            "missing": blocking,                   # 阻塞项
            "optional_missing": optional,
            "installed": not blocking,
        })
    return {
        "deps_dir": str(DEPS_DIR),
        "legacy_dir": str(LEGACY_DIR) if LEGACY_DIR.is_dir() else "",
        "deps_dir_exists": DEPS_DIR.is_dir(),
        "size_mb": dir_size_mb(DEPS_DIR) + (dir_size_mb(LEGACY_DIR) if LEGACY_DIR.is_dir() else 0),
        "features": feats,
    }


# ── 安装任务（后台 pip，带进度）────────────────────────────────────

_lock = threading.Lock()
_job: dict = {
    "running": False, "feature": "", "packages": [],
    "log": [], "done": False, "ok": False, "error": "",
    "started_at": 0, "finished_at": 0,
}


def job() -> dict:
    with _lock:
        return {k: (list(v) if isinstance(v, list) else v) for k, v in _job.items()}


def _append(line: str) -> None:
    with _lock:
        _job["log"].append(line.rstrip()[:300])
        if len(_job["log"]) > 200:
            _job["log"] = _job["log"][-200:]


def _run_pip(feature: str, packages: list[str]) -> None:
    DEPS_DIR.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "pip", "install", "--target", str(DEPS_DIR),
           "--upgrade", "-i", MIRROR, "--trusted-host", "pypi.tuna.tsinghua.edu.cn",
           *packages]
    _append("$ " + " ".join(cmd))
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        for line in proc.stdout:            # 逐行读，界面能看到实时进度
            _append(line)
        code = proc.wait()
        with _lock:
            _job.update({"ok": code == 0,
                         "error": "" if code == 0 else f"pip 退出码 {code}"})
    except Exception as e:
        with _lock:
            _job.update({"ok": False, "error": str(e)})
        _append(f"安装异常: {e}")
    finally:
        # 装完立即让新目录生效：ensure_path 会补挂 sys.path，invalidate_caches 清掉
        # importlib 的目录缓存，否则 find_spec 仍然找不到刚装好的包。
        try:
            ensure_path()
            importlib.invalidate_caches()
        except Exception:
            pass
        with _lock:
            _job.update({"running": False, "done": True, "finished_at": int(time.time())})


def _npm_exe() -> str | None:
    for name in ("npm.cmd", "npm"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _dep_spec(pkg: str) -> str:
    """从项目 package.json 取版本范围，避免装成另一个大版本（Electron 跨大版本会崩）"""
    try:
        d = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
        for field in ("devDependencies", "dependencies"):
            v = (d.get(field) or {}).get(pkg)
            if v:
                return str(v)
    except Exception:
        pass
    return ""


def _finish(ok: bool, error: str = "") -> None:
    with _lock:
        _job.update({"running": False, "done": True, "ok": ok, "error": error,
                     "finished_at": int(time.time())})


def _run_npm(feature: str, meta: dict) -> None:
    """Node 侧组件（目前只有 Electron 二进制）：npm install 回项目 node_modules。

    为什么要 --no-save：package.json 里本来就有 electron，重装只是为了补二进制，
    不该把版本范围改写成具体版本。
    """
    npm = _npm_exe()
    if not npm:
        _append("未找到 npm")
        _finish(False, "未找到 npm，请先安装 Node.js 18+ 再重试")
        return

    pkg = (meta.get("npm") or {}).get("package") or meta["packages"][0]
    spec = _dep_spec(pkg)
    arg = f"{pkg}@{spec}" if spec else pkg

    # 不走 shell：npm 常装在 "C://Program Files//nodejs"（路径带空格），
    # shell=True + 带引号的路径会让 cmd 剥引号，命令直接跑歪。
    # 直接 node npm-cli.js 最稳，也不依赖 .cmd 的 PATHEXT 解析。
    node = shutil.which("node")
    cli = Path(npm).parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if node and cli.exists():
        cmd = [node, str(cli), "install", arg, "--no-save", "--no-audit", "--no-fund"]
        use_shell = False
    else:
        cmd = [npm, "install", arg, "--no-save", "--no-audit", "--no-fund"]
        use_shell = os.name == "nt"
    _append("$ " + " ".join(cmd))
    try:
        env = dict(os.environ, ELECTRON_MIRROR=ELECTRON_MIRROR,
                   ELECTRON_BUILDER_BINARIES_MIRROR=ELECTRON_MIRROR.replace("/electron/", "/electron-builder-binaries/"))
        proc = subprocess.Popen(cmd, cwd=str(PROJECT_ROOT), shell=use_shell, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        for line in proc.stdout:
            _append(line)
        code = proc.wait()
        ok = code == 0 and _feature_installed(meta)
        _finish(ok, "" if ok else (
            ("npm 退出码 %s" % code) if code
            else ("安装命令成功，但没找到 %s（可能被代理拦截）" % meta["check"][0])))
    except Exception as e:
        _append(f"安装异常: {e}")
        _finish(False, str(e))


def install(feature: str) -> dict:
    meta = FEATURES.get(feature)
    if not meta:
        return {"ok": False, "error": "未知功能"}
    if not _applicable(meta):
        return {"ok": False, "error": "当前形态（打包版）不需要安装这个组件"}
    with _lock:
        if _job["running"]:
            return {"ok": False, "error": "已有安装任务在跑"}
        _job.update({
            "running": True, "feature": feature, "packages": list(meta["packages"]),
            "log": [], "done": False, "ok": False, "error": "",
            "started_at": int(time.time()), "finished_at": 0,
        })
    if meta.get("kind") == "npm":
        threading.Thread(target=_run_npm, args=(feature, meta), daemon=True).start()
    else:
        threading.Thread(target=_run_pip, args=(feature, meta["packages"]), daemon=True).start()
    return {"ok": True, "started": True}
