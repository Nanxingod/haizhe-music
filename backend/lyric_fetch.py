"""按需从网易云补齐缺失歌词（V15）

背景：曲库 740 首里基本都有歌词，这个功能只做**新歌兜底**，
所以设计成"手动触发 + 只补缺失"，不做全自动扫描。

三个安全约束：
1. **只在本地没有 .lrc 时写入**，已有歌词绝不覆盖（用户的词可能是精修过的）
2. **时长比对 ±3 秒**：网易云的 Live / 翻唱版本满天飞，只按歌名匹配很容易错版本
   （之前《东京不太热》就踩过：同名 3:44 和 3:58 两个版本）
3. 失败要给出**人能看懂的原因**，而不是直接空手而归
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": "https://music.163.com", "Cookie": "appver=2.0.2"}

SEARCH_API = "https://music.163.com/api/search/get?s={}&type=1&limit=5"
LYRIC_API = "https://music.163.com/api/song/lyric?id={}&lv=-1&kv=-1&tv=-1"

DURATION_TOLERANCE = 3.0     # 秒


def _get(url: str, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _local_lrc(song) -> Path:
    return Path(song.file_path).with_suffix(".lrc")


def find_lyric(song) -> tuple[str | None, str, dict]:
    """(歌词文本, 说明, 匹配到的曲目信息)。找不到时文本为 None，说明里写原因。"""
    query = f"{song.title} {song.artist}".strip()
    try:
        data = _get(SEARCH_API.format(urllib.parse.quote(query)))
    except Exception as e:
        return None, f"搜索失败：{e}", {}

    songs = (data.get("result") or {}).get("songs") or []
    if not songs:
        return None, "网易云没搜到这首歌", {}

    local = float(song.duration or 0)
    if local > 0:
        best = min(songs, key=lambda s: abs((s.get("duration") or 0) / 1000 - local))
        delta = (best.get("duration") or 0) / 1000 - local
        if abs(delta) > DURATION_TOLERANCE:
            return None, (f"时长不符：网易云 {best.get('duration', 0)/1000:.0f}s / "
                          f"本地 {local:.0f}s（差 {abs(delta):.0f}s，可能是别的版本）"), {}
    else:
        best = songs[0]
        delta = 0.0

    try:
        lyr = _get(LYRIC_API.format(best["id"]))
    except Exception as e:
        return None, f"取歌词失败：{e}", {}

    text = ((lyr.get("lrc") or {}).get("lyric") or "").strip()
    if not text:
        return None, "匹配到的那首在网易云没有歌词", {}

    info = {
        "netease_id": best["id"],
        "netease_title": best.get("name"),
        "netease_artists": "/".join(a.get("name", "") for a in (best.get("artists") or [])),
        "delta_sec": round(delta, 1),
    }
    return text, "ok", info


def fetch_one(song) -> dict:
    """给一首歌补歌词。返回 {ok, message, ...}"""
    dst = _local_lrc(song)
    if dst.exists():
        return {"ok": True, "skipped": True, "message": "已有歌词，跳过"}

    text, msg, info = find_lyric(song)
    if not text:
        return {"ok": False, "message": msg, "song": song.title, "artist": song.artist}

    try:
        dst.write_text(text, encoding="utf-8")
    except Exception as e:
        return {"ok": False, "message": f"写文件失败：{e}", "song": song.title}

    # 就地更新内存里的对象，省掉一次全库重扫（10 秒）
    try:
        song.lrc_path = str(dst.absolute())
        song.has_lrc = True
    except Exception:
        pass

    return {"ok": True, "message": "已补齐", "file": dst.name,
            "lines": len([l for l in text.splitlines() if l.strip()]), **info}


def fetch_missing(songs: list, limit: int = 20) -> dict:
    """批量补缺失的歌词。limit 控制单次请求时长（每首约 0.4s）。"""
    missing = [s for s in songs if not getattr(s, "has_lrc", False)]
    todo = missing[:max(1, min(limit, 50))]

    results, ok_count = [], 0
    for s in todo:
        r = fetch_one(s)
        r.update({"song": s.title, "artist": s.artist})
        if r.get("ok") and not r.get("skipped"):
            ok_count += 1
        results.append(r)
        time.sleep(0.25)          # 轻微限速，别把接口打急

    return {
        "checked": len(todo),
        "filled": ok_count,
        "remaining": max(0, len(missing) - len(todo)),
        "results": results,
    }
