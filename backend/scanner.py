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
    default = Path(r"D:\Music\lxmusic")
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
    """扫描音乐目录，预提取封面缩略图"""
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

    for i, filepath in enumerate(mp3_files):
        title, raw_artist = _parse_filename(filepath)
        individual = _split_artists(raw_artist)
        sid = _file_id(filepath)

        lrc_path = filepath.with_suffix(".lrc")
        has_lrc = lrc_path.exists()
        if not has_lrc:
            lrc_path = None

        # ⚡ 扫描时一并提取封面缩略图到磁盘缓存
        has_cover = _extract_and_cache_cover(filepath, sid)
        if has_cover:
            extracted += 1

        song = Song(
            id=sid,
            title=title,
            artist=raw_artist,
            artists=individual,
            file_path=str(filepath.absolute()),
            lrc_path=str(lrc_path.absolute()) if lrc_path else None,
            has_cover=has_cover,
            has_lrc=has_lrc,
            duration=_get_duration(filepath),
        )
        songs.append(song)

        for name in individual:
            if name not in artist_songs:
                artist_songs[name] = []
            artist_songs[name].append(song)

        # 进度提示（每 100 首）
        if (i + 1) % 100 == 0:
            print(f"  [Scanner] {i+1}/{total} ...")

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

    print(f"[Scanner] 完成: {len(songs)} 首歌, {len(artists)} 位歌手, {extracted} 个封面缩略图")
    return songs, artists


def get_songs_by_artist(songs: list[Song], artist: str) -> list[Song]:
    """获取包含指定歌手的所有歌曲（模糊匹配 artist 字段）"""
    return [s for s in songs if artist in s.artists]


def search_songs(songs: list[Song], query: str) -> list[Song]:
    """搜索歌曲（匹配歌名或歌手字段）"""
    q = query.lower()
    return [s for s in songs if q in s.title.lower() or q in s.artist.lower()]
