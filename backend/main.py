"""音乐播放器后端 - FastAPI 服务（V10.1 稳定版）"""

import os
import re
import gc
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from scanner import scan_all, search_songs, get_songs_by_artist, MUSIC_DIR, COVER_CACHE_DIR
from lyrics import parse_lrc
from models import Song, Artist

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
async def stream_audio(song_id: str, request: Request):
    song = next((s for s in ALL_SONGS if s.id == song_id), None)
    if not song:
        raise HTTPException(404, "歌曲不存在")

    filepath = song.file_path
    file_size = os.path.getsize(filepath)
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(
            filepath, media_type="audio/mpeg",
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
        with open(filepath, "rb") as f:
            f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                buf = f.read(min(STREAM_BUF, remaining))
                if not buf:
                    break
                remaining -= len(buf)
                yield buf

    return StreamingResponse(
        file_iterator(), status_code=206, media_type="audio/mpeg",
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


@app.get("/api/bg-images/{area}")
async def list_bg_images(area: str):
    if area not in ("main", "sidebar", "player"):
        raise HTTPException(400, "area 必须是 main / sidebar / player")
    bg_dir = Path(__file__).parent.parent / "frontend" / "public" / "bg" / area
    if not bg_dir.exists():
        return []
    exts = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
    return [{"name": f.name, "path": f"/bg/{area}/{f.name}"}
            for f in sorted(bg_dir.iterdir()) if f.is_file() and f.suffix.lower() in exts]


@app.get("/api/status")
async def get_status():
    thumb_count = len(list(COVER_CACHE_DIR.glob("*.jpg"))) if COVER_CACHE_DIR.exists() else 0
    return {"songs": len(ALL_SONGS), "artists": len(ARTISTS), "music_dir": str(MUSIC_DIR), "cached_covers": thumb_count}


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


if __name__ == "__main__":
    import uvicorn
    import logging
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    uvicorn.run(
        app, host="0.0.0.0", port=8765, log_level="warning",
        timeout_keep_alive=30, limit_concurrency=50, limit_max_requests=5000,
    )
