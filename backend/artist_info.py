"""歌手简介：取网易云音乐的公开接口（免费、无需 key、国内可直连）。

链路：
  1. `api/search/get?s=<歌手>&type=100` 搜歌手 → 得到 artist id / 头像 / 粉丝数
  2. `api/v1/artist/<id>` 拿 `briefDesc` 中文简介 + 曲库量

为什么选它（对比过的几个免费源）：
  - 维基百科 REST API：数据干净但是**国内直连不通**（被墙），无代理时必失败
  - MusicBrainz：免费但要英文名匹配，中文歌手简介基本为空
  - 百度百科：没有官方 API，抓 HTML 会被反爬拦
  - 网易云：`/api/v1/artist/<id>` 直接给中文 `briefDesc`，头部歌手 600+ 字

质量校验（必须做）：`briefDesc` 是歌手/编辑自己填的，质量参差。
实测陈粒的简介是 `ok…………………………`，所以对过短、无中文、字符种类过少的直接判为无简介。

缓存：`<音乐目录>/歌手简介/<歌手名>.json` 落盘（简介几乎不变，不自动过期）；
内存只留最近 8 条。查不到的只做短时负缓存，不落盘。
"""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from pathlib import Path

import scanner

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
SEARCH_API = "https://music.163.com/api/search/get?s={}&type=100&limit=5"
DETAIL_API = "https://music.163.com/api/v1/artist/{}"

DIR_NAME = "歌手简介"
MEM_MAX = 8
NEG_TTL = 600          # 查不到的结果只在内存留 10 分钟

# 国内站点优先直连（系统代理可能反而更慢/不稳），失败自动回退代理
_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_lock = threading.RLock()
_mem: "OrderedDict[str, dict]" = OrderedDict()
_neg: dict[str, float] = {}


# ── 基础工具 ─────────────────────────────────────────────────────

def _safe_name(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "_", name or "").strip().rstrip(".")
    return (s or "unknown")[:80]


def cache_dir() -> Path:
    return scanner.MUSIC_DIR / DIR_NAME


def _get_json(url: str, timeout: int = 10):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://music.163.com",
    })
    try:
        with _NO_PROXY.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        print(f"[Artist] 直连失败，回退代理: {type(e).__name__}: {e}")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))


def _clean_brief(text: str) -> str:
    """简介质量校验：太短 / 没中文 / 字符种类过少（ok……………）都判为无效。"""
    t = re.sub(r"\s+", " ", (text or "")).strip()
    if len(t) < 10:
        return ""
    zh = len(re.findall(r"[\u4e00-\u9fff]", t))
    if zh < 5:
        return ""
    if len(set(t)) <= 6:
        return ""
    return t


# ── 网络 ─────────────────────────────────────────────────────────

def search_artist(name: str) -> dict | None:
    url = SEARCH_API.format(urllib.parse.quote(name))
    try:
        d = _get_json(url)
    except Exception as e:
        print(f"[Artist] 搜索失败({name}): {e}")
        return None
    artists = ((d.get("result") or {}).get("artists") or [])
    if not artists:
        return None
    # 优先同名精确匹配，否则取粉丝最多的（搜索结果是按相关度排的，但不是严格同名）
    exact = [a for a in artists if (a.get("name") or "").strip() == name.strip()]
    pick = exact[0] if exact else max(artists, key=lambda a: a.get("fansSize") or 0)
    return pick


def fetch_detail(artist_id: int) -> dict | None:
    try:
        d = _get_json(DETAIL_API.format(artist_id))
    except Exception as e:
        print(f"[Artist] 详情失败({artist_id}): {e}")
        return None
    return d.get("artist") or None


# ── 缓存 ─────────────────────────────────────────────────────────

def _disk_path(name: str) -> Path:
    return cache_dir() / f"{_safe_name(name)}.json"


def _mem_get(name: str) -> dict | None:
    with _lock:
        d = _mem.get(name)
        if d is not None:
            _mem.move_to_end(name)
        return d


def _mem_put(name: str, data: dict) -> None:
    with _lock:
        _mem[name] = data
        _mem.move_to_end(name)
        while len(_mem) > MEM_MAX:
            _mem.popitem(last=False)


def _disk_get(name: str) -> dict | None:
    p = _disk_path(name)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    if "brief_source" not in data:
        # 早期版本没有这个字段。简介为空的记录值得重走一遍（现在有 AI 兜底了）
        if not data.get("brief"):
            return None
        data["brief_source"] = "api"
    return data


def _disk_put(name: str, data: dict) -> None:
    try:
        d = cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        _disk_path(name).write_text(
            json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception as e:
        print(f"[Artist] 写盘失败({name}): {e}")


# ── 对外 ─────────────────────────────────────────────────────────

def _ai_brief(name: str, alias: list[str], fans: int) -> str:
    """接口没给有效简介时（如陈粒那种 `ok…………`），让 DeepSeek 补一段。

    提示词刻意保守：只写广为流传的公开事实，不确定的不写，禁止编造奖项/销量。
    生成的文本会标记 brief_source="ai"，界面上会打 AI 标，不冒充官方简介。
    """
    try:
        import relinks  # 延迟导入，避免模块加载顺序问题（relinks 不反向依赖这里）
        if not relinks.keys()["deepseek"]:
            return ""
        alias_txt = "、".join(alias) if alias else "无"
        content = relinks._chat([
            {"role": "system", "content": "你是严谨的音乐百科编辑，只输出 JSON。"},
            {"role": "user", "content":
             f"请用中文客观介绍歌手「{name}」（别名：{alias_txt}）。\n"
             "要求：\n"
             "1. 150-250 字，一到两段，不要分点\n"
             "2. 只写广为流传、可公开查证的事实（出道年代、音乐风格、代表作品方向、影响力）\n"
             "3. 不确定的信息一律不写，禁止编造奖项、销量、具体日期\n"
             "4. 不要写「以下是为您生成的介绍」这类话，直接开始介绍\n"
             '只输出 JSON：{"brief":"..."}'},
        ], max_tokens=900, timeout=40)
        d = relinks._parse_json(content)
        return _clean_brief(str(d.get("brief") or ""))
    except Exception as e:
        print(f"[Artist] AI 补简介失败({name}): {e}")
        return ""


def _empty(name: str) -> dict:
    return {"found": False, "name": name, "alias": [], "avatar": "",
            "brief": "", "brief_source": "", "music_count": 0, "album_count": 0,
            "fans": 0, "source": "netease", "fetched_at": int(time.time())}


def get_info(name: str, force: bool = False) -> dict:
    name = (name or "").strip()
    if not name:
        return _empty(name)

    if not force:
        hit = _mem_get(name)
        if hit:
            return hit
        disk = _disk_get(name)
        if disk:
            _mem_put(name, disk)
            return disk
        ts = _neg.get(name)
        if ts and time.time() - ts < NEG_TTL:
            return _empty(name)

    artist = search_artist(name)
    info = _empty(name)
    if artist:
        aid = artist.get("id")
        detail = fetch_detail(aid) if aid else None
        src = detail or artist
        brief = _clean_brief(src.get("briefDesc") or "")
        info = {
            "found": True,
            "name": src.get("name") or name,
            "alias": [a for a in (src.get("alias") or []) if a],
            "avatar": src.get("picUrl") or artist.get("picUrl") or "",
            "brief": brief,
            "brief_source": "api" if brief else "",
            "music_count": int(src.get("musicSize") or 0),
            "album_count": int(src.get("albumSize") or 0),
            "fans": int(artist.get("fansSize") or 0),
            "source": "netease",
            "fetched_at": int(time.time()),
        }
        # 接口简介无效（或过短）时用 AI 补一段；生成一次就随缓存落盘
        if len(brief) < 40:
            ai = _ai_brief(info["name"], info["alias"], info["fans"])
            if ai:
                info["brief"] = ai
                info["brief_source"] = "ai"

    if info["found"]:
        _mem_put(name, info)
        _disk_put(name, info)
    else:
        with _lock:
            _neg[name] = time.time()
            if len(_neg) > 200:                      # 只留最近的，防止长期累积
                for k in sorted(_neg, key=_neg.get)[:100]:
                    _neg.pop(k, None)
    return info


def clear_cache(name: str | None = None) -> None:
    with _lock:
        if name:
            _mem.pop(name, None)
            _neg.pop(name, None)
        else:
            _mem.clear()
            _neg.clear()
