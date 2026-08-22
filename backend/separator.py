"""人声/伴奏分离 - 基于 audio-separator（UVR 模型）

依赖（可选，装在 backend/vendor/ 本地目录，不污染系统环境）：
    python -m pip install audio-separator --target backend/vendor
GPU 加速（本机已装 CUDA 版 torch，Roformer 高质量模型自动走 GPU）：
    python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126 --target backend/vendor
- 每首歌产出 FLAC（<音乐目录>/人声分离/<song_id>/vocals.flac + instrumental.flac，与曲库同处持久化）
- 质量分级：
    standard: UVR-MDX-NET-Inst_HQ_3（64MB，CPU 约 1-3 分钟，质量良好）
    hq:       BS-Roformer Viperx 1297（SDR 12.98，约 840MB，GPU 快/CPU 极慢）
"""

import json
import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Optional

_VENDOR = Path(__file__).parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

# 分离结果持久化在用户音乐目录下的「人声分离」文件夹（与歌曲同处、换机/备份曲库时跟随）。
# scanner 只扫 MUSIC_DIR 顶层的 .mp3 文件，此子目录不会被误认成歌曲。
# 目录可在设置页运行时切换，因此路径必须是动态函数而非模块常量。
import scanner  # noqa: E402


def stems_dir() -> Path:
    return scanner.MUSIC_DIR / "人声分离"


MODEL_DIR = Path(__file__).parent / "cache" / "stem_models"

# 一次性迁移：老版本把分离结果存在 backend/cache/stems/，启动时搬到新位置
_legacy_stems = Path(__file__).parent / "cache" / "stems"
if _legacy_stems.exists():
    for d in _legacy_stems.iterdir():
        if d.is_dir() and (stems_dir() / d.name / "vocals.flac").exists() is False:
            target = stems_dir() / d.name
            target.parent.mkdir(parents=True, exist_ok=True)
            d.replace(target)
    try:
        _legacy_stems.rmdir()  # 空了才删
    except OSError:
        pass

# 质量分级 → 模型文件（audio-separator 按文件名自动下载）
MODELS = {
    "standard": "UVR-MDX-NET-Inst_HQ_3.onnx",
    "hq": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
}

_lock = threading.Lock()
# song_id -> {"status": ..., "progress": ..., "error": ..., "quality": ...}
_tasks: dict[str, dict] = {}

_gpu_available: Optional[bool] = None


def _ensure_ffmpeg() -> bool:
    """audio-separator 依赖 ffmpeg。系统没有时尝试用 imageio-ffmpeg 自带的二进制。"""
    if shutil.which("ffmpeg"):
        return True
    try:
        import imageio_ffmpeg
        exe = Path(imageio_ffmpeg.get_ffmpeg_exe())
        # 二进制名形如 ffmpeg-win-x86_64-v7.1.exe，需要复制成 ffmpeg.exe 才能被 which/"ffmpeg" 找到
        standard = exe.parent / "ffmpeg.exe"
        if not standard.exists():
            try:
                os.link(exe, standard)  # 同盘硬链接，不占额外空间
            except OSError:
                shutil.copyfile(exe, standard)
        os.environ["PATH"] = str(exe.parent) + os.pathsep + os.environ.get("PATH", "")
        return shutil.which("ffmpeg") is not None
    except Exception:
        return False


def has_gpu() -> bool:
    """是否有可用的 CUDA GPU（torch CUDA 版）。延迟检测并缓存结果。"""
    global _gpu_available
    if _gpu_available is None:
        try:
            import torch
            _gpu_available = torch.cuda.is_available()
        except Exception:
            _gpu_available = False
    return _gpu_available


def is_available() -> bool:
    try:
        import audio_separator  # noqa: F401
        return _ensure_ffmpeg()
    except ImportError:
        return False


def stems_path(song_id: str, stem: str) -> Path:
    return stems_dir() / song_id / f"{stem}.flac"


def _meta_path(song_id: str) -> Path:
    return stems_dir() / song_id / "meta.json"


def cached_quality(song_id: str) -> Optional[str]:
    """读取已缓存分离结果所用质量。
    旧缓存（质量分级功能之前分离的）视为 standard；无任何缓存返回 None。"""
    if not stems_path(song_id, "vocals").exists():
        return None
    try:
        meta = json.loads(_meta_path(song_id).read_text(encoding="utf-8"))
        q = meta.get("quality")
        return q if q in MODELS else "standard"
    except Exception:
        return "standard"


def _set(song_id: str, **kw) -> None:
    with _lock:
        _tasks.setdefault(song_id, {}).update(kw)


def get_task(song_id: str) -> dict:
    with _lock:
        task = dict(_tasks.get(song_id, {}))
    if not task:
        return {"status": "none", "progress": 0}
    return task


def is_busy() -> bool:
    with _lock:
        return any(t.get("status") == "processing" for t in _tasks.values())


def start_separation(song_id: str, filepath: str, quality: str = "standard") -> Optional[str]:
    """启动分离任务（后台线程）。成功返回 None，失败返回错误消息。"""
    if quality not in MODELS:
        quality = "standard"
    if stems_path(song_id, "vocals").exists() and cached_quality(song_id) == quality:
        return None  # 已有同质量缓存
    if is_busy():
        return "已有分离任务在进行中，请等待完成后再试"
    with _lock:
        _tasks[song_id] = {"status": "processing", "progress": 2, "quality": quality}
    threading.Thread(target=_run, args=(song_id, filepath, quality), daemon=True).start()
    return None


def _run(song_id: str, filepath: str, quality: str) -> None:
    try:
        if not _ensure_ffmpeg():
            raise RuntimeError("ffmpeg 不可用（系统未安装且 imageio-ffmpeg 缺失）")

        from audio_separator.separator import Separator

        out_dir = stems_dir() / song_id
        out_dir.mkdir(parents=True, exist_ok=True)
        _set(song_id, status="processing", progress=5)

        # GPU 优先（Roformer 等大模型在 CPU 上极慢）；0.18 的 Separator
        # 自动检测 torch.cuda，这里只负责日志提示
        use_gpu = has_gpu()

        kwargs = {
            "output_dir": str(out_dir),
            "output_format": "FLAC",
            "model_file_dir": str(MODEL_DIR),
        }
        sep = Separator(**kwargs)

        _set(song_id, progress=8)
        model_name = MODELS[quality]
        sep.load_model(model_name)  # 首次使用自动下载模型
        _set(song_id, progress=15)
        outputs = sep.separate(filepath)
        _set(song_id, progress=90)

        # 归一化输出文件名（audio-separator 返回相对 output_dir 的路径）
        vocals = instrumental = None
        for f in outputs:
            p = Path(f)
            if not p.is_absolute():
                p = out_dir / p.name
            name = p.name.lower()
            if "vocals" in name:
                vocals = p
            elif "instrumental" in name:
                instrumental = p
        if not vocals or not instrumental:
            raise RuntimeError(f"分离输出不完整: {outputs}")

        vocals.replace(stems_path(song_id, "vocals"))
        instrumental.replace(stems_path(song_id, "instrumental"))
        # 记录质量标记（供 UI 展示与缓存判断）
        try:
            _meta_path(song_id).write_text(
                json.dumps({"quality": quality, "gpu": use_gpu}), encoding="utf-8")
        except Exception:
            pass
        _set(song_id, status="ready", progress=100)
        print(f"[Stems] 分离完成: {song_id} (quality={quality}, gpu={use_gpu})")
    except Exception as e:  # noqa: BLE001
        _set(song_id, status="error", error=str(e))
        print(f"[Stems] 分离失败 {song_id}: {e}")


def delete_stems(song_id: str) -> None:
    import shutil
    d = stems_dir() / song_id
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    with _lock:
        _tasks.pop(song_id, None)


def list_ready() -> list[dict]:
    """列出已分离缓存的歌曲（含磁盘占用 MB 与质量）。"""
    result: list[dict] = []
    if stems_dir().exists():
        for d in stems_dir().iterdir():
            if d.is_dir():
                v, i = stems_path(d.name, "vocals"), stems_path(d.name, "instrumental")
                if v.exists() and i.exists():
                    result.append({
                        "song_id": d.name,
                        "size_mb": round((v.stat().st_size + i.stat().st_size) / 1048576, 1),
                        "quality": cached_quality(d.name) or "standard",
                    })
    return sorted(result, key=lambda x: x["song_id"])
