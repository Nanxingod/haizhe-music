"""LRC 歌词解析器"""

import re
from models import Lyrics, LyricsLine

# 匹配 [mm:ss.xx] 或 [mm:ss]
LRC_TIME_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]")
LRC_TAG_RE = re.compile(r"\[(ti|ar|al|by|offset):(.+)\]", re.IGNORECASE)


def parse_lrc(filepath: str) -> Lyrics:
    """解析 LRC 文件"""
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    lines: list[LyricsLine] = []
    tags: dict[str, str] = {}

    for line in content.strip().split("\n"):
        line = line.strip()
        if not line:
            continue

        # 提取标签
        tag_match = LRC_TAG_RE.match(line)
        if tag_match:
            key = tag_match.group(1).lower()
            value = tag_match.group(2).strip()
            tags[key] = value
            continue

        # 提取时间标签 [mm:ss.xx]歌词
        times = []
        text_start = 0
        for m in LRC_TIME_RE.finditer(line):
            mins = int(m.group(1))
            secs = int(m.group(2))
            ms = m.group(3) or "0"
            ms = int(ms.ljust(3, "0")[:3])
            total_secs = mins * 60 + secs + ms / 1000.0
            times.append(total_secs)
            text_start = m.end()

        text = line[text_start:].strip()
        for t in times:
            lines.append(LyricsLine(time=t, text=text))

    lines.sort(key=lambda x: x.time)

    return Lyrics(
        lines=lines,
        ti=tags.get("ti"),
        ar=tags.get("ar"),
        al=tags.get("al"),
    )
