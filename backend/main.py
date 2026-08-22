"""音乐播放器后端 - FastAPI 服务（V10.1 稳定版）"""

import os
import re
import gc
import threading
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

import scanner
from scanner import scan_all, search_songs, get_songs_by_artist, COVER_CACHE_DIR
from lyrics import parse_lrc
from models import Song, Artist
import separator as stems_mod

app = FastAPI(title="小海蜇音乐播放器", version="2.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=500)

ALL_SONGS: list[Song] = []
ARTISTS: list[Artist] = []


@app.on_event("startup")
async def startup():
    global ALL_SONGS, ARTISTS
    ALL_SONGS, ARTISTS = scan_all()
    print(f"[Server] 启动完成，{len(ALL_SONGS)} 首歌就绪")


@app.get("/api/artists")
async def get_artists():
    return ARTISTS


@app.get("/api/artists/{artist_name}")
async def get_artist_songs(artist_name: str):
    songs = get_songs_by_artist(ALL_SONGS, artist_name)
    if not songs:
        raise HTTPException(404, f"歌手不存在: {artist_name}")
    return [_song_public(s) for s in songs]


def _song_public(s: Song) -> dict:
    return {
        "id": s.id, "title": s.title, "artist": s.artist,
        "artists": s.artists, "has_cover": s.has_cover,
        "has_lrc": s.has_lrc, "duration": s.duration,
    }


@app.get("/api/songs")
async def get_songs(
    search: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    if search:
        results = search_songs(ALL_SONGS, search)
    else:
        results = ALL_SONGS
    total = len(results)
    return {
        "total": total,
        "songs": [_song_public(s) for s in results[offset : offset + limit]],
    }


@app.get("/api/songs/{song_id}")
async def get_song(song_id: str):
    for s in ALL_SONGS:
        if s.id == song_id:
            return s
    raise HTTPException(404, f"歌曲不存在: {song_id}")


STREAM_BUF = 128 * 1024


@app.get("/api/stream/{song_id}")
async def stream_audio(song_id: str, request: Request, stem: str = Query(default="")):
    song = next((s for s in ALL_SONGS if s.id == song_id), None)
    if not song:
        raise HTTPException(404, "歌曲不存在")

    # V12: 支持播放分离出的人声/伴奏音轨（FLAC 缓存）
    if stem in ("vocals", "instrumental"):
        f = stems_mod.stems_path(song_id, stem)
        if not f.exists():
            raise HTTPException(404, f"该歌曲没有分离的{stem}音轨，请先执行分离")
        filepath, mime = str(f), "audio/flac"
    else:
        filepath, mime = song.file_path, "audio/mpeg"

    file_size = os.path.getsize(filepath)
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(
            filepath, media_type=mime,
            headers={"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600"},
        )

    range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not range_match:
        return Response(status_code=416)

    start = int(range_match.group(1))
    end_str = range_match.group(2)
    end = int(end_str) if end_str else file_size - 1

    if start >= file_size or end >= file_size:
        return Response(status_code=416)

    chunk_size = end - start + 1

    def file_iterator():
        try:
            with open(filepath, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    buf = f.read(min(STREAM_BUF, remaining))
                    if not buf:
                        break
                    remaining -= len(buf)
                    yield buf
        except Exception as e:
            # V10.3: 磁盘 I/O 异常（杀软拦截/文件锁定）会导致流媒体静默中断
            # 浏览器端只看到截断的响应，不会触发 error 事件 → 播放器卡死无声
            print(f"[Stream] 流媒体传输中断: {e}")

    return StreamingResponse(
        file_iterator(), status_code=206, media_type=mime,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Cache-Control": "public, max-age=3600",
        },
    )


# --- 封面接口（V10.1 原版：150px 缓存 / 原图按需）---

def _extract_raw_cover(filepath: str):
    """从 MP3 提取原始封面。返回 (data, mime) 或 None。"""
    try:
        from mutagen.id3 import ID3
        tags = ID3(filepath)
        for tag in tags.values():
            if tag.FrameID == "APIC":
                return tag.data, (tag.mime or "image/jpeg")
    except Exception:
        pass
    return None


@app.get("/api/cover/{song_id}")
async def get_cover(song_id: str, size: int = Query(default=150, ge=50, le=800)):
    """提取封面。size<800=磁盘缓存缩略图(毫秒级), size=800=MP3原图(仅全屏用)"""
    song = next((s for s in ALL_SONGS if s.id == song_id), None)
    if not song:
        raise HTTPException(404, "歌曲不存在")
    if not song.has_cover:
        raise HTTPException(404, "该歌曲没有封面")

    # 缩略图：从磁盘缓存直接返回（扫描时已预提取为 150px JPEG）
    if size < 800:
        thumb = COVER_CACHE_DIR / f"{song_id}.jpg"
        if thumb.exists():
            return FileResponse(
                thumb, media_type="image/jpeg",
                headers={"Cache-Control": "public, max-age=86400"},
            )
        raw = _extract_raw_cover(song.file_path)
        if raw:
            return Response(content=raw[0], media_type=raw[1],
                          headers={"Cache-Control": "public, max-age=86400"})
        raise HTTPException(404, "该歌曲没有封面")

    # 全屏大图：从 MP3 按需读取
    raw = _extract_raw_cover(song.file_path)
    if raw:
        return Response(content=raw[0], media_type=raw[1],
                      headers={"Cache-Control": "public, max-age=3600"})
    raise HTTPException(404, "该歌曲没有封面")


@app.get("/api/lyrics/{song_id}")
async def get_lyrics(song_id: str):
    song = next((s for s in ALL_SONGS if s.id == song_id), None)
    if not song:
        raise HTTPException(404, "歌曲不存在")
    if not song.lrc_path:
        raise HTTPException(404, "该歌曲没有歌词文件")
    try:
        return parse_lrc(song.lrc_path)
    except Exception as e:
        raise HTTPException(500, f"歌词解析失败: {e}")


# --- 背景图：默认图（frontend/public）+ 自定义上传（backend/cache/bg）---

_BG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
_BG_AREAS = ("main", "sidebar", "player")


def _bg_custom_dir(area: str) -> Path:
    return Path(__file__).parent / "cache" / "bg" / area


def _bg_public_dir(area: str) -> Path:
    return Path(__file__).parent.parent / "frontend" / "public" / "bg" / area


@app.get("/api/bg-images/{area}")
async def list_bg_images(area: str):
    """合并列出默认图（/bg/... 静态路径）与自定义上传图（/api/bg-image/... 路径）。"""
    if area not in _BG_AREAS:
        raise HTTPException(400, "area 必须是 main / sidebar / player")
    items = []
    pub = _bg_public_dir(area)
    if pub.exists():
        items += [{"name": f.stem, "file": f.name, "path": f"/bg/{area}/{f.name}", "custom": False}
                  for f in sorted(pub.iterdir()) if f.is_file() and f.suffix.lower() in _BG_EXTS]
    cus = _bg_custom_dir(area)
    if cus.exists():
        items += [{"name": f.stem, "file": f.name, "path": f"/api/bg-image/{area}/{f.name}", "custom": True}
                  for f in sorted(cus.iterdir()) if f.is_file() and f.suffix.lower() in _BG_EXTS]
    return items


@app.post("/api/bg-images/{area}")
async def upload_bg_image(area: str, request: Request, name: str = Query(default="")):
    """上传自定义背景图。body 为图片二进制，?name= 文件名（含扩展名）。"""
    if area not in _BG_AREAS:
        raise HTTPException(400, "area 必须是 main / sidebar / player")
    # 清理文件名：只留安全字符，防路径穿越
    safe = "".join(c for c in name if c.isalnum() or c in "-_.（）()[]【】 ")
    stem = Path(safe).stem or "custom"
    suffix = Path(safe).suffix.lower()
    if suffix not in _BG_EXTS:
        suffix = ".png"
    data = await request.body()
    if not data:
        raise HTTPException(400, "上传内容为空")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "图片超过 20MB 上限")
    d = _bg_custom_dir(area)
    d.mkdir(parents=True, exist_ok=True)
    # 重名时追加序号
    target = d / f"{stem}{suffix}"
    i = 1
    while target.exists():
        target = d / f"{stem}-{i}{suffix}"
        i += 1
    target.write_bytes(data)
    return {"name": target.stem, "path": f"/api/bg-image/{area}/{target.name}", "custom": True}


@app.get("/api/bg-image/{area}/{filename}")
async def get_bg_image(area: str, filename: str):
    if area not in _BG_AREAS:
        raise HTTPException(400, "area 非法")
    f = _bg_custom_dir(area) / Path(filename).name
    if not f.is_file():
        raise HTTPException(404, "图片不存在")
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"}.get(f.suffix.lower(), "image/png")
    return FileResponse(str(f), media_type=mime, headers={"Cache-Control": "public, max-age=3600"})


@app.delete("/api/bg-images/{area}/{filename}")
async def delete_bg_image(area: str, filename: str):
    if area not in _BG_AREAS:
        raise HTTPException(400, "area 非法")
    f = _bg_custom_dir(area) / Path(filename).name
    if not f.is_file():
        raise HTTPException(404, "图片不存在")
    f.unlink()
    return {"ok": True}


@app.get("/api/status")
async def get_status():
    thumb_count = len(list(COVER_CACHE_DIR.glob("*.jpg"))) if COVER_CACHE_DIR.exists() else 0
    return {"songs": len(ALL_SONGS), "artists": len(ARTISTS), "music_dir": str(scanner.MUSIC_DIR), "cached_covers": thumb_count}


# --- 音乐目录设置（设置页运行时切换曲库）---

@app.get("/api/config")
async def get_config():
    return {"music_dir": str(scanner.MUSIC_DIR)}


@app.post("/api/config")
def set_config(body: dict):
    """切换音乐目录：校验 → 写 config.json → 清缓存 → 全量重扫。
    同步 def（FastAPI 自动放线程池），冷扫描 7-14s 期间不阻塞事件循环（流媒体照常）。"""
    global ALL_SONGS, ARTISTS
    new_dir = str(body.get("music_dir") or "").strip()
    if not new_dir:
        raise HTTPException(400, "music_dir 不能为空")
    ok, msg = scanner.set_music_dir(new_dir)
    if not ok:
        raise HTTPException(400, msg)
    ALL_SONGS, ARTISTS = scan_all()
    print(f"[Config] 音乐目录已切换: {msg}，共 {len(ALL_SONGS)} 首")
    return {"music_dir": msg, "songs": len(ALL_SONGS), "artists": len(ARTISTS)}


# --- 人声/伴奏分离（V12，依赖可选：pip install audio-separator）---

@app.get("/api/stems")
async def stems_list():
    return {
        "available": stems_mod.is_available(),
        "gpu": stems_mod.has_gpu(),
        "items": stems_mod.list_ready(),
    }


@app.get("/api/stems/{song_id}")
async def stems_status(song_id: str):
    task = stems_mod.get_task(song_id)
    ready = stems_mod.stems_path(song_id, "vocals").exists()
    # 进行中的任务优先于旧缓存（如用 HQ 重分离时，旧 standard 缓存仍存在但不能掩盖进度）
    processing = task.get("status") == "processing"
    return {
        "available": stems_mod.is_available(),
        "gpu": stems_mod.has_gpu(),
        "status": "processing" if processing else ("ready" if ready else task.get("status", "none")),
        "progress": task.get("progress", 0) if processing else (100 if ready else task.get("progress", 0)),
        "quality": task.get("quality") if processing else (stems_mod.cached_quality(song_id) if ready else None),
        "error": task.get("error"),
    }


@app.post("/api/stems/{song_id}/separate")
async def stems_start(song_id: str, quality: str = Query(default="standard")):
    song = next((s for s in ALL_SONGS if s.id == song_id), None)
    if not song:
        raise HTTPException(404, "歌曲不存在")
    if not stems_mod.is_available():
        raise HTTPException(503, "后端未安装 audio-separator（pip install audio-separator）")
    if quality not in stems_mod.MODELS:
        quality = "standard"
    if stems_mod.stems_path(song_id, "vocals").exists() and stems_mod.cached_quality(song_id) == quality:
        return {"status": "ready"}
    err = stems_mod.start_separation(song_id, song.file_path, quality)
    if err:
        raise HTTPException(409, err)
    return {"status": "processing", "quality": quality}


@app.delete("/api/stems/{song_id}")
async def stems_delete(song_id: str):
    stems_mod.delete_stems(song_id)
    return {"ok": True}


@app.post("/api/refresh")
async def refresh_songs():
    global ALL_SONGS, ARTISTS
    old_count = len(ALL_SONGS)
    ALL_SONGS, ARTISTS = scan_all()
    gc.collect()
    new_count = len(ALL_SONGS)
    print(f"[Refresh] {old_count} -> {new_count} ({(new_count - old_count):+d})")
    return {"songs": new_count, "artists": len(ARTISTS), "delta": new_count - old_count}


@app.on_event("startup")
async def setup_gc_timer():
    import asyncio
    async def periodic_gc():
        while True:
            await asyncio.sleep(300)
            collected = gc.collect()
            if collected > 0:
                print(f"[GC] 回收 {collected} 个对象")
    asyncio.create_task(periodic_gc())
    # GPU 预检测放后台线程：torch 导入耗时 1-2s，避免首次打开效果面板时阻塞请求
    threading.Thread(target=stems_mod.has_gpu, daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    import logging
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    # V10.2: 移除 limit_max_requests — worker 重启会导致流媒体中断
    # 引发前端 MEDIA_ERR_NETWORK → 错误处理器无限切歌的死亡螺旋
    # 个人音乐播放器无需 worker 回收；Python GC 每 5 分钟运行足够
    uvicorn.run(
        app, host="0.0.0.0", port=8765, log_level="warning",
        timeout_keep_alive=30, limit_concurrency=50,
    )
