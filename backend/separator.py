"""人声/伴奏分离 - 基于 audio-separator（UVR 模型）

依赖（可选，装在 backend/vendor/ 本地目录，不污染系统环境）：
    python -m pip install audio-separator --target backend/vendor
GPU 加速（本机已装 CUDA 版 torch，Roformer 高质量模型自动走 GPU）：
    python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126 --target backend/vendor
- 每首歌产出 FLAC（<音乐目录>/人声分离/<原文件名>_<C|G>/vocals.flac + instrumental.flac，与曲库同处持久化）
- 目录名 = 原歌曲文件名 + 处理方式：C=标准模型(CPU)，G=高质量模型(GPU)
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


def _mode(quality: str) -> str:
    """处理方式标识：standard/CPU → C，hq/GPU → G（用于分离目录命名）"""
    return "G" if quality == "hq" else "C"


# 分离目录名 = 「原文件名_处理方式(C/G)」，无法从目录名反推 song_id，
# 因此用各目录 meta.json 里记录的 song_id 建立索引，按 song_id 快速定位。
_song_dirs: dict[str, Path] = {}
_index_built = False


def _rebuild_index() -> None:
    """扫描 stems_dir，从各目录 meta.json 重建 song_id -> 目录 索引。"""
    global _index_built
    with _lock:
        _song_dirs.clear()
        _index_built = True
        if stems_dir().exists():
            for d in stems_dir().iterdir():
                if not d.is_dir():
                    continue
                try:
                    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
                except Exception:
                    continue
                sid = meta.get("song_id")
                if sid:
                    _song_dirs[sid] = d


def _song_dir(song_id: str) -> Optional[Path]:
    if not _index_built:
        _rebuild_index()  # 首次访问或音乐目录已切换后重建
    return _song_dirs.get(song_id)


def stems_path(song_id: str, stem: str) -> Path:
    d = _song_dir(song_id)
    return (d / f"{stem}.flac") if d else stems_dir() / f"{stem}.flac"


def _meta_path(song_id: str) -> Path:
    d = _song_dir(song_id)
    return (d / "meta.json") if d else stems_dir() / "meta.json"


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


def _new_dir_for(filepath: str, quality: str, song_id: str) -> Path:
    """为新分离任务确定目标目录：<原文件名>_<C|G>。
    若同名目录已被其他歌占用（meta.song_id 不一致），自动追加序号。"""
    base = stems_dir() / f"{Path(filepath).stem}_{_mode(quality)}"
    d = base
    if d.exists():
        try:
            meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        if meta.get("song_id") != song_id:
            i = 2
            while (stems_dir() / f"{base.name}_{i}").exists():
                i += 1
            d = stems_dir() / f"{base.name}_{i}"
    d.parent.mkdir(parents=True, exist_ok=True)
    return d


def start_separation(song_id: str, filepath: str, quality: str = "standard") -> Optional[str]:
    """启动分离任务（后台线程）。成功返回 None，失败返回错误消息。"""
    if quality not in MODELS:
        quality = "standard"
    existing = _song_dir(song_id)
    if existing and cached_quality(song_id) == quality:
        return None  # 已有同质量缓存
    if is_busy():
        return "已有分离任务在进行中，请等待完成后再试"
    out_dir = _new_dir_for(filepath, quality, song_id)
    with _lock:
        _tasks[song_id] = {"status": "processing", "progress": 2, "quality": quality}
    threading.Thread(target=_run, args=(song_id, filepath, quality, out_dir), daemon=True).start()
    return None


def _run(song_id: str, filepath: str, quality: str, out_dir: Path) -> None:
    try:
        if not _ensure_ffmpeg():
            raise RuntimeError("ffmpeg 不可用（系统未安装且 imageio-ffmpeg 缺失）")

        from audio_separator.separator import Separator

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

        vocals.replace(out_dir / "vocals.flac")
        instrumental.replace(out_dir / "instrumental.flac")
        # 记录归属（song_id/filepath）与质量标记（供 UI 展示、缓存判断与索引）
        try:
            (out_dir / "meta.json").write_text(
                json.dumps({"song_id": song_id, "filepath": filepath,
                            "quality": quality, "gpu": use_gpu},
                           ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
        with _lock:
            _song_dirs[song_id] = out_dir
        _set(song_id, status="ready", progress=100)
        print(f"[Stems] 分离完成: {song_id} -> {out_dir.name} (quality={quality}, gpu={use_gpu})")
    except Exception as e:  # noqa: BLE001
        _set(song_id, status="error", error=str(e))
        print(f"[Stems] 分离失败 {song_id}: {e}")


def delete_stems(song_id: str) -> None:
    d = _song_dir(song_id)
    if d and d.exists():
        shutil.rmtree(d, ignore_errors=True)
    with _lock:
        _tasks.pop(song_id, None)
        _song_dirs.pop(song_id, None)


def list_ready() -> list[dict]:
    """列出已分离缓存的歌曲（含磁盘占用 MB 与质量）。"""
    result: list[dict] = []
    if stems_dir().exists():
        for d in stems_dir().iterdir():
            if d.is_dir():
                v, i = d / "vocals.flac", d / "instrumental.flac"
                if v.exists() and i.exists():
                    try:
                        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
                    except Exception:
                        meta = {}
                    quality = meta.get("quality")
                    result.append({
                        "song_id": meta.get("song_id") or d.name,
                        "size_mb": round((v.stat().st_size + i.stat().st_size) / 1048576, 1),
                        "quality": quality if quality in MODELS else "standard",
                    })
    return sorted(result, key=lambda x: x["song_id"])


def migrate_legacy(song_files: dict[str, str]) -> None:
    """一次性迁移：把老式 song_id 命名的分离目录改名为「原文件名_处理方式(C/G)」。
    老目录名即 song_id，meta 只有 quality/gpu；改名后补写 song_id/filepath。"""
    if not stems_dir().exists():
        return
    for d in stems_dir().iterdir():
        if not d.is_dir():
            continue
        meta_p = d / "meta.json"
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if meta.get("song_id"):
            continue  # 已是新式命名
        filepath = song_files.get(d.name)  # 老目录名即 song_id
        if not filepath:
            continue  # 曲库已无此歌，无法取名，保留原样
        quality = meta.get("quality", "standard")
        if quality not in MODELS:
            quality = "standard"
        new_name = f"{Path(filepath).stem}_{_mode(quality)}"
        target = stems_dir() / new_name
        if target.exists():
            i = 2
            while (stems_dir() / f"{new_name}_{i}").exists():
                i += 1
            target = stems_dir() / f"{new_name}_{i}"
        meta["song_id"] = d.name
        meta["filepath"] = filepath
        try:
            meta_p.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
        d.replace(target)
        print(f"[Stems] 迁移命名: {d.name} -> {target.name}")
    _rebuild_index()
