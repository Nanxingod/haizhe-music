"""音乐文件扫描器 - 扫描目录、读取元数据、预提取封面缩略图"""

import os
import re
import json
import hashlib
from pathlib import Path
from io import BytesIO
from typing import Optional

from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC

from models import Song, Artist

# 从 config.json 读取音乐目录
def _load_music_dir() -> Path:
    config_path = Path(__file__).parent / "config.json"
    # config.json 不存在时的默认值（用户「音乐」文件夹，跨平台）
    default = Path.home() / "Music"
    try:
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            d = cfg.get("music_dir", "")
            if d:
                p = Path(d)
                if p.exists():
                    return p
                print(f"[Scanner] 音乐目录不存在: {d}，使用默认")
    except Exception as e:
        print(f"[Scanner] 配置读取失败: {e}")
    return default

MUSIC_DIR = _load_music_dir()

# 封面缩略图缓存目录
COVER_CACHE_DIR = Path(__file__).parent / "cache" / "covers"


def set_music_dir(new_dir: str) -> tuple[bool, str]:
    """运行时切换音乐目录（设置页调用）。写回 config.json + 更新模块变量 + 清扫描缓存。
    返回 (成功?, 消息)。注意：from scanner import MUSIC_DIR 拿到的是旧绑定，
    切换后请通过 scanner.MUSIC_DIR 动态访问。"""
    global MUSIC_DIR
    p = Path(new_dir)
    if not p.is_dir():
        return False, f"目录不存在或不可访问: {new_dir}"
    config_path = Path(__file__).parent / "config.json"
    try:
        cfg = {}
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        cfg["music_dir"] = str(p)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        return False, f"写入配置失败: {e}"
    MUSIC_DIR = p
    # 目录变了，元数据缓存全部失效
    try:
        if SCAN_CACHE_PATH.exists():
            SCAN_CACHE_PATH.unlink()
    except Exception:
        pass
    return True, str(p)

# ── 元数据缓存（V11 启动优化）──
# 旧版每次启动都全量解析 676 个 MP3（mutagen 每文件 10-20ms → 扫描 7-14 秒），
# 且 FastAPI startup 事件同步完成后才监听端口 → 窗口干等。
# 现在以 (文件名, mtime, size) 为键缓存解析结果，温启动扫描 < 1 秒。
SCAN_CACHE_VERSION = 1
SCAN_CACHE_PATH = Path(__file__).parent / "cache" / "scan_cache.json"


def _load_scan_cache() -> dict:
    try:
        with open(SCAN_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("version") == SCAN_CACHE_VERSION and data.get("music_dir") == str(MUSIC_DIR):
            return data.get("files", {})
    except Exception:
        pass
    return {}


def _save_scan_cache(files: dict):
    try:
        SCAN_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = SCAN_CACHE_PATH.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(
                {"version": SCAN_CACHE_VERSION, "music_dir": str(MUSIC_DIR), "files": files},
                f, ensure_ascii=False,
            )
        tmp.replace(SCAN_CACHE_PATH)  # 原子替换，避免写一半崩溃留下坏缓存
    except Exception as e:
        print(f"[Scanner] 元数据缓存写入失败: {e}")

# 多歌手分隔符
ARTIST_SPLIT_RE = re.compile(r"[、,，/&]|\bfeat\.?\b", re.IGNORECASE)


def _split_artists(raw: str) -> list[str]:
    """将 "徐良、阿悄" 拆分成 ["徐良", "阿悄"]"""
    parts = ARTIST_SPLIT_RE.split(raw)
    return [p.strip() for p in parts if p.strip()]


def _parse_filename(filepath: Path) -> tuple[str, str]:
    """从文件名解析歌曲名和歌手"""
    name = filepath.stem
    parts = name.rsplit(" - ", 1)
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return name.strip(), "Unknown"


def _file_id(filepath: Path) -> str:
    relative = filepath.relative_to(MUSIC_DIR)
    return hashlib.md5(str(relative).encode()).hexdigest()[:12]


def _get_duration(filepath: Path) -> Optional[float]:
    try:
        audio = MP3(filepath)
        return audio.info.length
    except Exception:
        return None


def _extract_and_cache_cover(filepath: Path, song_id: str) -> bool:
    """从 MP3 提取封面，缩放为 150px JPEG 存入磁盘缓存。"""
    thumb_path = COVER_CACHE_DIR / f"{song_id}.jpg"
    if thumb_path.exists():
        return True

    try:
        tags = ID3(filepath)
        for tag in tags.values():
            if tag.FrameID == "APIC":
                _save_thumbnail(tag.data, thumb_path, 150)
                return True
    except Exception:
        pass
    return False


def _save_thumbnail(data: bytes, dest: Path, size: int = 150):
    """将图片数据缩放并保存为 JPEG"""
    try:
        from PIL import Image
        img = Image.open(BytesIO(data))
        # 已够小则不缩放
        if img.width > size or img.height > size:
            img.thumbnail((size, size), Image.LANCZOS)
        # 转 RGB（透明图白底合成）
        if img.mode == 'RGBA':
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.getchannel('A'))
            img = bg
        elif img.mode == 'P':
            img = img.convert('RGBA')
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.getchannel('A'))
            img = bg
        elif img.mode != 'RGB':
            img = img.convert('RGB')
        img.save(dest, format='JPEG', quality=82, optimize=True)
    except Exception as e:
        print(f"  [Cover] 缩放失败 {dest.name}: {e}")


def scan_all() -> tuple[list[Song], list[Artist]]:
    """扫描音乐目录，预提取封面缩略图（带元数据缓存）"""
    songs: list[Song] = []
    artist_songs: dict[str, list[Song]] = {}

    # 确保缓存目录存在
    COVER_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    if not MUSIC_DIR.exists():
        print(f"[Scanner] 目录不存在: {MUSIC_DIR}")
        return [], []

    mp3_files = [f for f in MUSIC_DIR.iterdir() if f.is_file() and f.suffix.lower() == ".mp3"]
    total = len(mp3_files)
    extracted = 0
    cache_hits = 0

    cache = _load_scan_cache()
    new_cache: dict = {}

    for i, filepath in enumerate(mp3_files):
        sid = _file_id(filepath)

        lrc_path = filepath.with_suffix(".lrc")
        has_lrc = lrc_path.exists()
        if not has_lrc:
            lrc_path = None

        # ⚡ 缓存命中：文件未变（mtime+size 一致）则跳过 mutagen 全量解析
        st = filepath.stat()
        cached = cache.get(filepath.name)
        if cached and cached.get("mtime") == st.st_mtime and cached.get("size") == st.st_size:
            title = cached["title"]
            raw_artist = cached["artist"]
            individual = cached["artists"]
            has_cover = cached["has_cover"]
            duration = cached["duration"]
            cache_hits += 1
        else:
            title, raw_artist = _parse_filename(filepath)
            individual = _split_artists(raw_artist)
            # ⚡ 扫描时一并提取封面缩略图到磁盘缓存
            has_cover = _extract_and_cache_cover(filepath, sid)
            if has_cover:
                extracted += 1
            duration = _get_duration(filepath)

        new_cache[filepath.name] = {
            "mtime": st.st_mtime, "size": st.st_size,
            "title": title, "artist": raw_artist, "artists": individual,
            "has_cover": has_cover, "duration": duration,
        }

        song = Song(
            id=sid,
            title=title,
            artist=raw_artist,
            artists=individual,
            file_path=str(filepath.absolute()),
            lrc_path=str(lrc_path.absolute()) if lrc_path else None,
            has_cover=has_cover,
            has_lrc=has_lrc,
            duration=duration,
        )
        songs.append(song)

        for name in individual:
            if name not in artist_songs:
                artist_songs[name] = []
            artist_songs[name].append(song)

        # 进度提示（每 100 首）
        if (i + 1) % 100 == 0:
            print(f"  [Scanner] {i+1}/{total} ...")

    _save_scan_cache(new_cache)

    artists = [
        Artist(
            name=name,
            song_count=len(slist),
            cover_song_id=slist[0].id if slist[0].has_cover else None,
        )
        for name, slist in sorted(
            artist_songs.items(), key=lambda x: -len(x[1])
        )
    ]

    print(f"[Scanner] 完成: {len(songs)} 首歌, {len(artists)} 位歌手, "
          f"{extracted} 个新封面, 缓存命中 {cache_hits}/{total}")
    return songs, artists


def get_songs_by_artist(songs: list[Song], artist: str) -> list[Song]:
    """获取包含指定歌手的所有歌曲（模糊匹配 artist 字段）"""
    return [s for s in songs if artist in s.artists]


def search_songs(songs: list[Song], query: str) -> list[Song]:
    """搜索歌曲（匹配歌名或歌手字段）"""
    q = query.lower()
    return [s for s in songs if q in s.title.lower() or q in s.artist.lower()]
