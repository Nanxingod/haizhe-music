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
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
CONFIG_FILE = BACKEND / "config.json"

# ① 默认位置（按需安装到这里）
if os.name == "nt":
    DEFAULT_DEPS_DIR = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "Haizhe" / "deps"
else:
    DEFAULT_DEPS_DIR = Path.home() / ".local" / "share" / "haizhe" / "deps"

DEPS_DIR = DEFAULT_DEPS_DIR          # 实际生效值，由 refresh_dir() 更新
_dir_source = "default"              # env / config / default

# ② 老位置（历史上 pip --target 到 backend/vendor，继续认）
LEGACY_DIR = BACKEND / "vendor"

MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"
# CPU 版 torch 从 PyPI/清华镜像拿；CUDA 版只有官方 index 有（Windows 上这点尤其关键）
TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu126"
ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
PROJECT_ROOT = BACKEND.parent

# audio-separator 0.18 要求 torch >= 2.0
MIN_TORCH = (2, 0)


def _read_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def resolve_deps_dir() -> tuple[Path, str]:
    """依赖目录优先级：环境变量 > config.json > 默认 %LOCALAPPDATA%。

    做成可配置是因为 2.5GB 放在 C 盘对很多人不现实；但**默认不改**——
    %LOCALAPPDATA% 不需要管理员权限、天然按用户隔离、项目目录移动也不影响它。
    """
    env = (os.environ.get("HAIZHE_DEPS_DIR") or "").strip()
    if env:
        return Path(env).expanduser(), "env"
    raw = str(_read_config().get("deps_dir") or "").strip()
    if raw:
        return Path(raw).expanduser(), "config"
    return DEFAULT_DEPS_DIR, "default"


def refresh_dir() -> str:
    """重新解析依赖目录，返回来源。改完 config.json 后调用即可生效。"""
    global DEPS_DIR, _dir_source
    DEPS_DIR, _dir_source = resolve_deps_dir()
    return _dir_source


def _init_dir() -> None:
    global DEPS_DIR, _dir_source
    DEPS_DIR, _dir_source = resolve_deps_dir()


_init_dir()

# 功能 → (展示名, 说明, 需要的包)
FEATURES = {
    "stems": {
        "name": "人声 / 伴奏分离",
        "desc": "分离出人声轨后，旋律功能才能算准；也用于「效果 → 音轨」",
        "packages": ["torch", "audio-separator", "imageio-ffmpeg"],
        "torch": True,                     # 需要区分 CPU / CUDA 变体
        "heavy": True,
    },
    "melody": {
        "name": "旋律（音高走向图）",
        "desc": "librosa 必需；torchcrepe 是加速项（装了走 CREPE 23 秒，没装退化 pyin 140 秒）",
        "packages": ["librosa", "torchcrepe"],
        "required": ["librosa"],          # torchcrepe 缺失不阻塞，只是慢
        "torch": True,                    # torchcrepe 依赖 torch，同样要选变体
        "heavy": True,
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


_injected: list[str] = []


def ensure_path() -> list[str]:
    """把依赖目录挂到 sys.path，返回实际生效的目录列表。

    注意 sys.path 顺序：deps 目录插在最前面，所以它会**遮蔽** .venv / 系统里的同名包。
    这正是「.venv 装了 CUDA torch 却被 deps 里的 CPU torch 抢先」的原因，
    所以切换目录时必须把旧路径摘掉。
    """
    used = []
    for d in (DEPS_DIR, LEGACY_DIR):
        if not d.is_dir():
            continue
        sp = str(d)
        used.append(sp)
        if sp not in sys.path:
            sys.path.insert(0, sp)
            _injected.append(sp)
    for sp in list(_injected):
        if sp not in used:
            try:
                sys.path.remove(sp)
            except ValueError:
                pass
            _injected.remove(sp)
    return used


# ── GPU / torch 实际状态探测 ────────────────────────────────────────
# 为什么用子进程：import torch 要 1-2 秒、常驻几百 MB，而 status 只是想知道
# "装的是哪个版本、能不能用 GPU"。子进程还能避免装坏的包把整个后端拖崩。

_gpu_cache: dict = {"at": 0.0, "data": None}
_torch_cache: dict = {"at": 0.0, "data": None}


def gpu_info(force: bool = False) -> dict:
    """NVIDIA 显卡信息（nvidia-smi；没有就是不可用，不是错误）"""
    now = time.time()
    if not force and _gpu_cache["data"] and now - _gpu_cache["at"] < 300:
        return dict(_gpu_cache["data"])
    data = {"available": False, "name": "", "memory_mb": 0, "driver": "", "count": 0}
    exe = shutil.which("nvidia-smi")
    if exe:
        try:
            out = subprocess.run(
                [exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=8,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            ).stdout.strip()
            rows = [r for r in out.splitlines() if r.strip()]
            if rows:
                parts = [x.strip() for x in rows[0].split(",")]
                mem = "".join(ch for ch in (parts[1] if len(parts) > 1 else "") if ch.isdigit())
                data.update({
                    "available": True,
                    "name": parts[0] if parts else "",
                    "memory_mb": int(mem) if mem else 0,
                    "driver": parts[2] if len(parts) > 2 else "",
                    "count": len(rows),
                })
        except Exception:
            pass
    _gpu_cache.update({"at": now, "data": dict(data)})
    return data


_TORCH_PROBE = r"""
import json
out = {"installed": False, "version": "", "cuda": False, "cuda_version": "",
       "file": "", "device_count": 0, "error": ""}
try:
    import torch
    out["installed"] = True
    out["version"] = getattr(torch, "__version__", "") or ""
    try:
        out["cuda"] = bool(torch.cuda.is_available())
        out["device_count"] = int(torch.cuda.device_count()) if out["cuda"] else 0
    except Exception as e:
        out["error"] = "cuda check: %s" % e
    out["cuda_version"] = getattr(getattr(torch, "version", None), "cuda", "") or ""
    out["file"] = getattr(torch, "__file__", "") or ""
except Exception as e:
    out["error"] = "%s: %s" % (type(e).__name__, e)
print(json.dumps(out))
"""


def torch_state(force: bool = False) -> dict:
    """实际生效的 torch：版本 / 是否 CUDA / 装在哪。

    打包版（PyInstaller）里 sys.executable 是应用自身，`-c` 不可用，直接跳过探测。
    """
    empty = {"installed": False, "version": "", "cuda": False, "cuda_version": "",
             "file": "", "device_count": 0, "where": "", "error": "", "probed": True}
    now = time.time()
    if not force and _torch_cache["data"] and now - _torch_cache["at"] < 120:
        return dict(_torch_cache["data"])
    if getattr(sys, "frozen", False):
        data = dict(empty, probed=False, error="打包版无法探测，请查看启动日志")
        _torch_cache.update({"at": now, "data": data})
        return dict(data)

    env = dict(os.environ)
    paths = [str(d) for d in (DEPS_DIR, LEGACY_DIR) if d.is_dir()]
    old = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(paths + ([old] if old else []))
    data = dict(empty)
    try:
        r = subprocess.run([sys.executable, "-c", _TORCH_PROBE], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=30, env=env,
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        line = ""
        for ln in (r.stdout or "").strip().splitlines():
            if ln.strip().startswith("{"):
                line = ln.strip()
        if line:
            data.update(json.loads(line))
        else:
            data["error"] = (r.stderr or "探测无输出").strip()[:200]
    except Exception as e:
        data["error"] = "%s: %s" % (type(e).__name__, e)

    f = data.get("file") or ""
    if f:
        # .../site-packages/torch/__init__.py → .../site-packages
        data["where"] = str(Path(f).resolve().parent.parent)
    _torch_cache.update({"at": now, "data": dict(data)})
    return dict(data)


def torch_ok(version: str) -> bool:
    """主版本是否满足 audio-separator 的要求（不做完整 PEP440 解析）"""
    try:
        parts = re.findall(r"\d+", version or "")
        return tuple(int(x) for x in parts[:2]) >= MIN_TORCH
    except Exception:
        return False


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


def _norm_pkg(name: str) -> str:
    return name.replace("-", "_").lower()


_ver_cache: dict = {"at": 0.0, "data": {}}


def installed_version(pkg: str) -> tuple[str, str]:
    """从 deps 目录的 dist-info 读版本，返回 (版本, 所在目录)。

    不 import 包（import torch 要 2 秒且吃内存）；只读 METADATA 的 Version 字段。
    """
    now = time.time()
    if now - _ver_cache["at"] > 60:
        _ver_cache.update({"at": now, "data": {}})
    cache = _ver_cache["data"]
    if pkg in cache:
        return cache[pkg]
    key = _norm_pkg(pkg)
    found = ("", "")
    for d in (DEPS_DIR, LEGACY_DIR):
        if not d.is_dir():
            continue
        for meta in list(d.glob("*.dist-info/METADATA")) + list(d.glob("*.egg-info/PKG-INFO")):
            stem = meta.parent.name
            for suffix in (".dist-info", ".egg-info"):
                if stem.endswith(suffix):
                    stem = stem[: -len(suffix)]
                    break
            base = stem.rsplit("-", 1)[0]     # 去掉版本号，只留包名
            if _norm_pkg(base) != key:
                continue
            try:
                txt = meta.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for line in txt.splitlines():
                if line.lower().startswith("version:"):
                    found = (line.split(":", 1)[1].strip(), str(d))
                    break
            if found[0]:
                break
        if found[0]:
            break
    cache[pkg] = found
    return found


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
    gpu = gpu_info()
    torch = torch_state()
    feats = []
    for key, meta in FEATURES.items():
        if not _applicable(meta):
            continue
        blocking, optional = _feature_missing(meta)
        item = {
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
            "needs_torch": bool(meta.get("torch")),
        }
        if meta.get("kind", "pip") == "pip":
            vers = {p: installed_version(p) for p in meta["packages"]}
            item["versions"] = {p: v[0] for p, v in vers.items()}
            # 实际生效位置：可能来自 deps、旧 vendor，或当前 Python 环境
            where_dirs = {v[1] for v in vers.values() if v[1]}
            if where_dirs:
                item["where"] = sorted(where_dirs)[0]
            elif not blocking:
                item["where"] = "当前 Python 环境（.venv / 系统）"
            # 装了 torch 但主版本太老 → 明确提示，别让它静默跑失败
            tv = item["versions"].get("torch") or ""
            if tv and not torch_ok(tv):
                item["version_warn"] = (
                    f"torch {tv} 低于 audio-separator 要求的 {MIN_TORCH[0]}.{MIN_TORCH[1]}+，请重新安装")
        feats.append(item)

    use = usage()
    # 体积从账本里取：单独再走一遍 vendor（7GB / 3.8 万文件）会让每次请求多花 1.5 秒
    size_mb = round(sum(u["size_mb"] for u in use if u["key"] in ("deps", "vendor")), 1)
    return {
        "deps_dir": str(DEPS_DIR),
        "deps_dir_source": _dir_source,      # env / config / default
        "default_deps_dir": str(DEFAULT_DEPS_DIR),
        "legacy_dir": str(LEGACY_DIR) if LEGACY_DIR.is_dir() else "",
        "deps_dir_exists": DEPS_DIR.is_dir(),
        "size_mb": size_mb,
        "gpu": gpu,
        "torch": torch,
        "torch_ok": torch_ok(torch.get("version", "")) if torch.get("installed") else None,
        "usage": use,
        "features": feats,
    }


# ── 磁盘账本与缓存清理 ─────────────────────────────────────────────
# 只清「可再生」的东西（分离结果 / 旋律 / 画像 / 封面缩略图），
# 不碰已装的包（卸载包会把依赖图搞坏，收益也低）。

def _cache_targets() -> dict:
    """target → (显示名, 路径函数)。惰性 import：deps 要在没有 fastapi 时也能当 CLI 用。"""
    import scanner
    out = {
        "covers": ("封面缩略图", lambda: scanner.COVER_CACHE_DIR),
        "melody": ("旋律缓存", lambda: scanner.MUSIC_DIR / "旋律"),
        "insights": ("曲库画像缓存", lambda: scanner.MUSIC_DIR / "曲库分析"),
    }
    try:
        import separator
        out["stems"] = ("人声分离结果", separator.stems_dir)
    except Exception:
        pass
    return out


_usage_cache: dict = {"at": 0.0, "data": None}


def usage(force: bool = False) -> list[dict]:
    """各类资源占用（设置页展示）。失败不影响主流程。

    走一遍 vendor（7GB / 3.8 万文件）要 1 秒以上，所以缓存 60 秒；
    装完包、清完缓存要立刻失效（见 install / clean）。
    """
    now = time.time()
    if not force and _usage_cache["data"] and now - _usage_cache["at"] < 60:
        return [dict(x) for x in _usage_cache["data"]]
    items = [
        {"key": "deps", "label": "功能组件（Python）", "path": str(DEPS_DIR),
         "size_mb": dir_size_mb(DEPS_DIR), "cleanable": False},
    ]
    if LEGACY_DIR.is_dir():
        items.append({"key": "vendor", "label": "旧版组件目录", "path": str(LEGACY_DIR),
                      "size_mb": dir_size_mb(LEGACY_DIR), "cleanable": False})
    try:
        import separator
        items.append({"key": "hq_models", "label": "高质量分离模型",
                      "path": str(separator.MODEL_DIR),
                      "size_mb": dir_size_mb(separator.MODEL_DIR), "cleanable": False})
    except Exception:
        pass
    try:
        for k, (label, fn) in _cache_targets().items():
            d = fn()
            items.append({"key": k, "label": label, "path": str(d),
                          "size_mb": dir_size_mb(d), "cleanable": True})
    except Exception:
        pass
    _usage_cache.update({"at": now, "data": [dict(x) for x in items]})
    return items


def clean(target: str) -> dict:
    """清空某个缓存目录（保留目录本身）。返回释放的 MB。"""
    targets = _cache_targets()
    if target not in targets:
        return {"ok": False, "error": "不支持清理这个目标"}
    label, fn = targets[target]
    d = fn()
    if not d.is_dir():
        return {"ok": True, "freed_mb": 0.0, "path": str(d)}
    # 安全检查：必须落在音乐目录或后端 cache 下，避免误删
    try:
        d.resolve().relative_to(BACKEND.joinpath("cache").resolve())
        safe = True
    except ValueError:
        try:
            import scanner
            d.resolve().relative_to(scanner.MUSIC_DIR.resolve())
            safe = True
        except Exception:
            safe = False
    if not safe:
        return {"ok": False, "error": f"路径不在可清理范围内：{d}"}

    before = dir_size_mb(d)
    failed = 0
    for root, _dirs, files in os.walk(d, topdown=False):
        for f in files:
            try:
                os.remove(os.path.join(root, f))
            except OSError:
                failed += 1
    # 子目录也删掉（只保留根目录）
    for child in list(d.iterdir()):
        if child.is_dir():
            try:
                shutil.rmtree(child, ignore_errors=True)
            except Exception:
                pass
    _usage_cache["at"] = 0.0                 # 账本立即失效
    freed = round(max(0.0, before - dir_size_mb(d)), 1)
    return {"ok": failed == 0, "freed_mb": freed, "path": str(d),
            "error": f"{failed} 个文件删除失败" if failed else ""}


# ── 安装任务（后台 pip，带进度）────────────────────────────────────

_lock = threading.Lock()
_job: dict = {
    "running": False, "feature": "", "packages": [], "variant": "",
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


def _pip_cmds(meta: dict, variant: str) -> list[list[str]]:
    """把一次安装拆成若干条 pip 命令。

    为什么要拆：CUDA 版 torch 只在 download.pytorch.org 的 index 里，
    而 audio-separator 这些包只在 PyPI/镜像里。一条命令没法同时用两个 index，
    所以先装 torch（带 index-url），再装其余（走镜像）。
    """
    pkgs = list(meta["packages"])
    torch_pkgs = [p for p in pkgs if _norm_pkg(re.split(r"[<>=!~ ]", p)[0]) == "torch"]
    if meta.get("torch") and not torch_pkgs:
        # 例如 melody 的 torchcrepe：它依赖 torch 但包名里没有 torch。
        # 必须先把选定变体的 torch 装好，后面的包才不会从镜像再拖一个 CPU 版进来。
        torch_pkgs = ["torch>=%d.%d" % MIN_TORCH]
    rest = [p for p in pkgs if p not in torch_pkgs]
    base = [sys.executable, "-m", "pip", "install", "--target", str(DEPS_DIR), "--upgrade"]
    mirror = ["-i", MIRROR, "--trusted-host", "pypi.tuna.tsinghua.edu.cn"]
    cmds: list[list[str]] = []
    if torch_pkgs:
        if variant == "cuda":
            cmds.append(base + ["--index-url", TORCH_CUDA_INDEX, *torch_pkgs])
        else:
            cmds.append(base + mirror + torch_pkgs)
    if rest:
        cmds.append(base + mirror + rest)
    return cmds


def resolve_variant(meta: dict, variant: str = "auto") -> str:
    """torch 变体：显式指定优先；auto 时按有没有 NVIDIA 卡决定"""
    if not meta.get("torch"):
        return ""
    v = (variant or "auto").strip().lower()
    if v in ("cpu", "cuda"):
        return v
    return "cuda" if gpu_info().get("available") else "cpu"


def _run_pip(feature: str, meta: dict, variant: str) -> None:
    DEPS_DIR.mkdir(parents=True, exist_ok=True)
    ok = False
    err = ""
    try:
        # pip 的下载缓存默认在 %LOCALAPPDATA%\pip\cache（C 盘）。CUDA torch 的 wheel
        # 好几个 GB，光把安装目录改到 D 盘还不够，缓存也要跟着走。
        env = dict(os.environ, PIP_CACHE_DIR=str(DEPS_DIR.parent / "pip-cache"))
        for cmd in _pip_cmds(meta, variant):
            _append("$ " + " ".join(cmd))
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace", env=env,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            for line in proc.stdout:        # 逐行读，界面能看到实时进度
                _append(line)
            code = proc.wait()
            if code != 0:
                # 注意：前一条命令成功过，这里必须显式置 False，
                # 否则"torch 装上、audio-separator 失败"会被当成整体成功
                ok = False
                err = f"pip 退出码 {code}（{cmd[-1]}）"
                break
            ok = True

        # 装完必须回读真实状态：pip 说成功不等于拿到的是想要的变体
        # （Windows 上从 PyPI 拿到的 torch 一定是 CPU 版，这点最容易骗过人）
        if ok and meta.get("torch"):
            st = torch_state(force=True)
            _ver_cache["at"] = 0.0
            if not st.get("installed"):
                ok = False
                err = "安装后仍无法 import torch：" + (st.get("error") or "未知原因")
            elif not torch_ok(st.get("version", "")):
                ok = False
                err = f"torch {st.get('version')} 低于要求的 {MIN_TORCH[0]}.{MIN_TORCH[1]}+"
            elif variant == "cuda" and not st.get("cuda"):
                ok = False
                err = ("CUDA 版没生效（torch %s，cuda_available=False）。"
                       "检查显卡驱动，或代理是否拦截了 download.pytorch.org"
                       % (st.get("version") or "?"))
            else:
                _append("[deps] 生效：torch %s · %s" % (
                    st.get("version"), "CUDA " + (st.get("cuda_version") or "可用") if st.get("cuda") else "CPU"))
    except Exception as e:
        ok = False
        err = str(e)
        _append(f"安装异常: {e}")
    finally:
        # 装完立即让新目录生效：ensure_path 会补挂 sys.path，invalidate_caches 清掉
        # importlib 的目录缓存，否则 find_spec 仍然找不到刚装好的包。
        try:
            ensure_path()
            importlib.invalidate_caches()
        except Exception:
            pass
        _usage_cache["at"] = 0.0
        with _lock:
            _job.update({"running": False, "done": True, "ok": ok, "error": err,
                         "finished_at": int(time.time())})


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
    _usage_cache["at"] = 0.0
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


def install(feature: str, variant: str = "auto") -> dict:
    meta = FEATURES.get(feature)
    if not meta:
        return {"ok": False, "error": "未知功能"}
    if not _applicable(meta):
        return {"ok": False, "error": "当前形态（打包版）不需要安装这个组件"}
    var = resolve_variant(meta, variant)
    with _lock:
        if _job["running"]:
            return {"ok": False, "error": "已有安装任务在跑"}
        _job.update({
            "running": True, "feature": feature, "packages": list(meta["packages"]),
            "variant": var,
            "log": [], "done": False, "ok": False, "error": "",
            "started_at": int(time.time()), "finished_at": 0,
        })
    if meta.get("kind") == "npm":
        threading.Thread(target=_run_npm, args=(feature, meta), daemon=True).start()
    else:
        threading.Thread(target=_run_pip, args=(feature, meta, var), daemon=True).start()
    return {"ok": True, "started": True, "variant": var}


# ── 命令行入口 ─────────────────────────────────────────────────────
# 统一入口，README 和界面按钮都指向它，避免"界面装到 A、命令行装到 B"的分裂。
#
#   python backend/deps.py status
#   python backend/deps.py install stems --cuda
#   python backend/deps.py install melody
#   python backend/deps.py clean stems
#   python backend/deps.py dir D:////Haizhe//deps

def _write_deps_dir(path: str) -> dict:
    """把 deps_dir 写进 config.json（保留其它字段）"""
    cfg = _read_config()
    cfg["deps_dir"] = str(Path(path).expanduser()) if path else ""
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG_FILE)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "deps_dir": str(refresh_dir())}


def _cli(argv: list[str] | None = None) -> int:
    import argparse

    try:                                    # Windows 控制台默认 GBK，中文会炸
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(prog="deps.py", description="海蜇音乐 · 可选依赖管理")
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("status", help="查看组件状态、GPU/torch 实际生效版本、磁盘占用")

    pi = sub.add_parser("install", help="安装某个功能组件")
    pi.add_argument("feature", choices=sorted(FEATURES.keys()))
    g = pi.add_mutually_exclusive_group()
    g.add_argument("--cuda", action="store_true", help="装 CUDA 版 torch（体积大、有 NVIDIA 卡才选）")
    g.add_argument("--cpu", action="store_true", help="装 CPU 版 torch（体积小、慢）")

    pc = sub.add_parser("clean", help="清空某个可再生缓存")
    pc.add_argument("target", choices=["stems", "melody", "insights", "covers"])

    pd = sub.add_parser("dir", help="查看或设置依赖目录（写入 config.json）")
    pd.add_argument("path", nargs="?", default=None)

    args = ap.parse_args(argv)

    if args.cmd == "status":
        st = status()
        gpu = st["gpu"]
        t = st["torch"]
        print("依赖目录: %s（来源 %s）" % (st["deps_dir"], st["deps_dir_source"]))
        print("GPU     : %s" % (("%s · %sMB" % (gpu["name"], gpu["memory_mb"])) if gpu["available"] else "未检测到 NVIDIA 显卡"))
        if t.get("installed"):
            print("torch   : %s · %s · %s" % (
                t.get("version"), "CUDA 可用" if t.get("cuda") else "CPU", t.get("where") or t.get("file")))
        else:
            print("torch   : 未安装%s" % (("（%s）" % t["error"]) if t.get("error") else ""))
        print()
        for f in st["features"]:
            mark = "已安装" if f["installed"] else ("缺 " + "、".join(f["missing"]))
            print("  %-8s %-14s %s" % (f["key"], mark, f["size_hint"] or f["where"]))
        print()
        total = sum(u["size_mb"] for u in st["usage"])
        for u in st["usage"]:
            print("  %-16s %8.1f MB  %s" % (u["label"], u["size_mb"], u["path"]))
        print("  %-16s %8.1f MB" % ("合计", total))
        return 0

    if args.cmd == "install":
        meta = FEATURES[args.feature]
        variant = "cuda" if args.cuda else ("cpu" if args.cpu else "auto")
        # CLI 需要阻塞执行，不能像 HTTP 那样丢给后台线程
        var = resolve_variant(meta, variant)
        if meta.get("torch"):
            guessed = gpu_info()
            print("torch 变体: %s%s" % (var, "" if guessed["available"] else "（未检测到 NVIDIA 卡）"))
        with _lock:
            _job.update({"running": True, "feature": args.feature, "packages": list(meta["packages"]),
                         "variant": var, "log": [], "done": False, "ok": False, "error": "",
                         "started_at": int(time.time()), "finished_at": 0})
        if meta.get("kind") == "npm":
            _run_npm(args.feature, meta)
        else:
            _run_pip(args.feature, meta, var)
        j = job()
        for line in j["log"][-20:]:
            print("  " + line)
        print()
        print("结果: %s" % ("成功" if j["ok"] else ("失败 - " + (j["error"] or "见日志"))))
        return 0 if j["ok"] else 1

    if args.cmd == "clean":
        r = clean(args.target)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1

    if args.cmd == "dir":
        if args.path is None:
            print(str(DEPS_DIR))
            return 0
        r = _write_deps_dir(args.path)
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("ok") else 1

    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
