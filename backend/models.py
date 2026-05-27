"""音乐播放器后端 - 数据模型"""
from pydantic import BaseModel
from typing import Optional


class Song(BaseModel):
    id: str
    title: str
    artist: str          # 显示用原始名（如 "徐良、阿悄"）
    artists: list[str]    # 拆分后的独立歌手名（如 ["徐良", "阿悄"]）
    file_path: str
    lrc_path: Optional[str] = None
    has_cover: bool = False
    has_lrc: bool = False
    duration: Optional[float] = None


class Artist(BaseModel):
    name: str
    song_count: int
    cover_song_id: Optional[str] = None


class LyricsLine(BaseModel):
    time: float
    text: str


class Lyrics(BaseModel):
    lines: list[LyricsLine]
    ti: Optional[str] = None
    ar: Optional[str] = None
    al: Optional[str] = None
