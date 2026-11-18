"""收藏 / 歌单 / 最近播放（V14.8）

存储：`<音乐目录>/播放数据.json` —— 和其它缓存（相关视频/旋律/歌手简介）一样，
放在音乐目录里，换目录或备份音频时会跟着走。

为什么不放 localStorage：
- 换浏览器/清缓存就没了；桌面端和网页端要能共享同一份
- 741 首的收藏+歌单+历史也就几十 KB，单文件读写足够

为什么用 JSON 而不是 SQLite：
- 无并发写入场景（单机单用户），一个锁 + 临时文件原子替换就够
- 出问题时肉眼可读、可手改、可备份

数据结构：
{
  "version": 1,
  "favorites": ["song_id", ...],              # 「我喜欢」= 内置歌单
  "playlists": [{"id","name","songs":[],"created"}],
  "history":   [{"id","at"}]                  # 最近在前，最多 500
}
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

import scanner

FILE_NAME = "播放数据.json"
HISTORY_MAX = 500
FAV_ID = "favorites"
FAV_NAME = "我喜欢"

_lock = threading.RLock()
_cache: tuple[Path, dict] | None = None


def _path() -> Path:
    return scanner.MUSIC_DIR / FILE_NAME


def _blank() -> dict:
    return {"version": 1, "favorites": [], "playlists": [], "history": []}


def load() -> dict:
    """读数据（带进程内缓存，按文件路径失效——切音乐目录后自动重读）"""
    global _cache          # 下面会赋值，不声明 global 的话整个函数里它就是局部变量
    p = _path()
    if _cache is not None and _cache[0] == p:
        return _cache[1]
    data = _blank()
    if p.exists():
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data.update(raw)
        except Exception as e:
            print(f"[Library] 读取失败，按空数据继续: {e}")
    for k, v in _blank().items():
        data.setdefault(k, v)
    _cache = (p, data)
    return data


def _save(data: dict) -> None:
    """原子写：先写 .tmp 再 replace，避免写一半断电把数据弄坏"""
    global _cache
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)
    _cache = (p, data)


# ── 收藏 ──────────────────────────────────────────────────────────

def is_favorite(song_id: str) -> bool:
    with _lock:
        return song_id in load()["favorites"]


def toggle_favorite(song_id: str) -> bool:
    """返回切换后的状态（True=已收藏）"""
    with _lock:
        data = load()
        favs = data["favorites"]
        if song_id in favs:
            favs.remove(song_id)
            on = False
        else:
            favs.append(song_id)
            on = True
        _save(data)
        return on


# ── 歌单 ──────────────────────────────────────────────────────────

def list_playlists() -> list[dict]:
    with _lock:
        return [{"id": p["id"], "name": p["name"], "count": len(p.get("songs", []))}
                for p in load()["playlists"]]


def create_playlist(name: str) -> dict:
    name = (name or "").strip()[:40] or "未命名歌单"
    with _lock:
        data = load()
        pl = {"id": "pl_" + uuid.uuid4().hex[:8], "name": name, "songs": [],
              "created": int(time.time())}
        data["playlists"].append(pl)
        _save(data)
        return {"id": pl["id"], "name": pl["name"], "count": 0}


def rename_playlist(pid: str, name: str) -> bool:
    name = (name or "").strip()[:40]
    if not name:
        return False
    with _lock:
        data = load()
        for p in data["playlists"]:
            if p["id"] == pid:
                p["name"] = name
                _save(data)
                return True
        return False


def delete_playlist(pid: str) -> bool:
    with _lock:
        data = load()
        before = len(data["playlists"])
        data["playlists"] = [p for p in data["playlists"] if p["id"] != pid]
        if len(data["playlists"]) != before:
            _save(data)
            return True
        return False


def toggle_in_playlist(pid: str, song_id: str) -> bool | None:
    """返回加入后的状态；歌单不存在返回 None"""
    with _lock:
        data = load()
        for p in data["playlists"]:
            if p["id"] == pid:
                songs = p.setdefault("songs", [])
                if song_id in songs:
                    songs.remove(song_id)
                    on = False
                else:
                    songs.append(song_id)
                    on = True
                _save(data)
                return on
        return None


def add_to_playlist(pid: str, song_id: str) -> bool | None:
    """显式加入（已存在也算成功，幂等）。歌单不存在返回 None。"""
    with _lock:
        data = load()
        for p in data["playlists"]:
            if p["id"] == pid:
                songs = p.setdefault("songs", [])
                if song_id not in songs:
                    songs.append(song_id)
                    _save(data)
                return True
        return None


def remove_from_playlist(pid: str, song_id: str) -> bool | None:
    with _lock:
        data = load()
        for p in data["playlists"]:
            if p["id"] == pid:
                songs = p.setdefault("songs", [])
                if song_id in songs:
                    songs.remove(song_id)
                    _save(data)
                return True
        return None


def playlists_of(song_id: str) -> list[str]:
    """这首歌在哪些歌单里（菜单打勾用）"""
    with _lock:
        return [p["id"] for p in load()["playlists"] if song_id in p.get("songs", [])]


def playlist_songs(pid: str) -> list[str] | None:
    """返回歌单里的歌曲 id（按加入顺序）；favorites 走收藏"""
    with _lock:
        data = load()
        if pid == FAV_ID:
            return list(data["favorites"])
        for p in data["playlists"]:
            if p["id"] == pid:
                return list(p.get("songs", []))
        return None


def playlist_name(pid: str) -> str | None:
    with _lock:
        if pid == FAV_ID:
            return FAV_NAME
        for p in load()["playlists"]:
            if p["id"] == pid:
                return p["name"]
        return None


# ── 最近播放 ──────────────────────────────────────────────────────

def record_play(song_id: str) -> None:
    """记一条播放。同一首歌 3 分钟内重复播放只更新时间，不刷屏。"""
    now = int(time.time())
    with _lock:
        data = load()
        hist = data["history"]
        if hist and hist[0].get("id") == song_id and now - hist[0].get("at", 0) < 180:
            hist[0]["at"] = now
        else:
            hist.insert(0, {"id": song_id, "at": now})
            # 同一首歌只留最近一次，避免单曲循环把历史刷满
            seen = set()
            deduped = []
            for h in hist:
                if h["id"] in seen:
                    continue
                seen.add(h["id"])
                deduped.append(h)
            data["history"] = deduped[:HISTORY_MAX]
        _save(data)


def recent_ids(limit: int = HISTORY_MAX) -> list[str]:
    with _lock:
        return [h["id"] for h in load()["history"][:limit]]


def summary() -> dict:
    with _lock:
        data = load()
        return {
            "favorites": len(data["favorites"]),
            "playlists": [{"id": p["id"], "name": p["name"], "count": len(p.get("songs", []))}
                          for p in data["playlists"]],
            "recent": len(data["history"]),
        }


def clear_cache() -> None:
    """切音乐目录后调用，强制下次重新读文件"""
    global _cache
    with _lock:
        _cache = None


def file_path() -> Path:
    """给备份/诊断用"""
    return _path()
