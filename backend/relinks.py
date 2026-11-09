"""AI 辅助检索：为当前播放的歌找「现场版 / 优质翻唱 / MV」外链。

三个数据来源，各司其职：

1. **B站** —— 官方搜索接口 `api.bilibili.com/x/web-interface/search/all/v2`
   实测免登录可用（老版 `search/type` 被风控返回 HTML，`all/v2` 正常返回 JSON）。
   免费、稳定、信息全（标题/UP主/播放量/时长），所以**主搜 B站**。

2. **抖音** —— 官方搜索接口强制登录（`status_code 2483 请先登录`），网页版是纯前端壳，
   搜索引擎也 302 拦截。所以走 **Tavily 搜索 API** 搜 `douyin.com` 域名内的内容页。
   Tavily 按次计费，所以只做两个查询（现场/翻唱）当"点缀"，不铺量。

3. **DeepSeek** —— 两处用：
   a. 规划搜索词（把「晴天 周杰伦」变成「… 演唱会现场」「… 吉他弹唱 翻唱」这类高命中词）
   b. 给候选归类（现场版 / 翻唱 / MV / 其他）+ 打分 + 写一句中文短评
   没配 key 或调用失败时，退化成规则版（关键词命中 + 播放量），功能不中断。

## 两段式返回（首屏 ~0.8 秒，完整结果后台补齐）

- `get_result()` 第一次调用：同步只做「规则查询词 + B站三查询 + 规则打分」→ 立即可用，
  标记 `pending: true`，同时起后台线程做「AI 规划更准的词 + B站补一轮 + 抖音 + AI 归类」
- 前端每 2 秒轮询同一接口，拿到 `pending: false` 的完整结果后停

## 缓存：磁盘持久化为主，内存只留极少量

搜索结果**真实花钱**，而且时效性不强（一首歌的现场版不会今天有明天没），所以落盘：

```
<音乐目录>/相关视频/<原歌曲文件名>.json      ← 与曲库同处，换机/备份跟着走
```

三级缓存，越靠前越省：

| 层 | 位置 | 容量 | 失效 |
|---|---|---|---|
| 任务态 | `_jobs`（内存） | 最多 4 个并发任务 | 任务结束即删，不常驻 |
| 内存 LRU | `_mem`（OrderedDict） | **最多 6 条** | 30 分钟 TTL 或被挤出 |
| 磁盘 | `<音乐目录>/相关视频/` | 不限 | **不自动过期**，靠面板刷新按钮手动更新 |

磁盘记录里保存 `caps`（当时有没有 DeepSeek/Tavily key）。如果当时是规则版、现在配了 key，
读盘时判定为"能力已升级"，自动重搜而不是拿旧的低质量结果糊弄。
"""
from __future__ import annotations

import html
import json
import math
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as futures_wait
from pathlib import Path

import scanner  # MUSIC_DIR 运行时可切换，所有路径必须动态取

CONFIG_PATH = Path(__file__).parent / "config.json"

BILI_API = "https://api.bilibili.com/x/web-interface/search/all/v2"
TAVILY_API = "https://api.tavily.com/search"
DEEPSEEK_API = "https://api.deepseek.com/chat/completions"
DEEPSEEK_SEARCH_API = "https://api.deepseek.com/v1/tools/search"
DEEPSEEK_MODEL = "deepseek-flash"

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

# ⚡ 国内站点绕开系统代理：实测同一台机器上 api.bilibili.com
#   走 HTTP_PROXY 要 7.7 秒，直连 0.5 秒（15 倍差距），而且代理偶尔回 502 Tunnel。
#   这里准备一个"空代理"opener，B站 请求优先直连，失败再回退到环境代理。
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

GROUP_ORDER = ["live", "cover", "mv", "other"]
GROUP_LABEL = {"live": "现场版", "cover": "优秀翻唱", "mv": "MV", "other": "其他相关"}
SRC_LABEL = {"bilibili": "B站", "douyin": "抖音"}

# 每个分组内、每个来源最多展示几条（MV 只留 1 条）
PER_SRC_LIMIT = {"live": 4, "cover": 4, "mv": 1, "other": 2}
GROUP_MAX = {"mv": 1}

# 送进 LLM 排序的候选配额（固定配额，避免抖音量大时把 B站挤出去）
BILI_KEEP = 11
DOUYIN_KEEP = 6
MAX_CANDIDATES = BILI_KEEP + DOUYIN_KEEP

# ── 缓存参数 ──────────────────────────────────────────────────────
REL_DIR_NAME = "相关视频"
DISK_VERSION = 1
MEM_MAX = 6               # 内存里最多留 6 份，超出按 LRU 淘汰
MEM_TTL = 1800            # 内存 30 分钟；磁盘不自动过期
SEARCH_BUDGET_FAST = 8      # 首屏：B站三路总预算（秒）
SEARCH_BUDGET_FULL = 12     # 后台：含抖音五路总预算
MAX_JOBS = 4                # 同时最多 4 个后台补齐任务


def warmup() -> None:
    """启动时预热 B站 连接：首次 DNS/TLS 往往要 1-2 秒，
    不预热的话用户第一次双击歌名会白等这一下。失败无所谓。"""
    try:
        search_bilibili("音乐", 1)
    except Exception:
        pass

# ── 规则版兜底用的关键词 ──────────────────────────────────────────────
# B站结果最低播放量：低于这个数的多是随手拍/低质搬运，用户明确要求过滤（默认 2000）
MIN_BILI_PLAY = 2000


def _min_bili_play() -> int:
    """允许在 backend/config.json 里用 min_bili_play 覆盖，不用改代码。"""
    try:
        v = int(_read_cfg().get("min_bili_play", MIN_BILI_PLAY))
        return max(0, v)
    except Exception:
        return MIN_BILI_PLAY


MV_WORDS = ("mv", "music video", "official video", "原版mv", "官方mv")
LIVE_WORDS = ("现场", "live", "演唱会", "巡演", "音乐会", "不插电", "unplugged",
              "音乐节", "concert", "礼堂", "体育馆")
COVER_WORDS = ("翻唱", "cover", "改编", "女声", "男声", "少女音", "童声", "对唱",
               "吉他", "钢琴", "口琴", "素人", "合唱", "清唱", "翻自", "同人",
               "指弹", "remix", "弹唱", "小提琴", "古筝")

_lock = threading.RLock()
_mem: "OrderedDict[str, dict]" = OrderedDict()   # song_id -> 完整结果
_jobs: dict[str, dict] = {}                      # song_id -> {"fast": dict, "t0": float}
_disk_index: dict[str, Path] = {}                # song_id -> json 路径
_disk_index_built = False


# ══════════════════════════════════════════════════════════════════
# 配置 / HTTP 小工具
# ══════════════════════════════════════════════════════════════════

def _read_cfg() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _write_cfg(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def save_keys(deepseek: str | None = None, tavily: str | None = None) -> dict:
    """写入/清除检索用的 key（存 backend/config.json，该文件已被 .gitignore 排除）。"""
    cfg = _read_cfg()
    if deepseek is not None:
        ds = deepseek.strip()
        if ds:
            cfg["deepseek_api_key"] = ds
        else:
            cfg.pop("deepseek_api_key", None)
    if tavily is not None:
        tv = tavily.strip()
        if tv:
            cfg["tavily_api_key"] = tv
        else:
            cfg.pop("tavily_api_key", None)
    _write_cfg(cfg)
    return status()


def keys() -> dict:
    """读取 key：config.json 优先，其次环境变量。"""
    import os
    cfg = _read_cfg()
    return {
        "deepseek": (cfg.get("deepseek_api_key") or os.environ.get("DEEPSEEK_API_KEY") or "").strip(),
        "tavily": (cfg.get("tavily_api_key") or os.environ.get("TAVILY_API_KEY") or "").strip(),
    }


def status() -> dict:
    k = keys()
    # deepseek key 同时支撑「AI 归类」和「抖音搜索（DeepSeek Search）」；
    # tavily 是可选的抖音备用通道
    return {"deepseek": bool(k["deepseek"]), "search": bool(k["deepseek"]),
            "tavily": bool(k["tavily"])}


def _get_json(url: str, headers: dict | None = None, timeout: int = 15,
              direct: bool = False):
    """direct=True 时优先绕开系统代理（国内站点更快），失败再回退代理。"""
    req = urllib.request.Request(url, headers={"User-Agent": _UA, **(headers or {})})
    if direct:
        try:
            with _NO_PROXY_OPENER.open(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except Exception as e:
            print(f"[Relink] 直连失败，回退代理: {type(e).__name__}: {e}")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _post_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 40):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json", "User-Agent": _UA, **(headers or {})},
        method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _clean(t: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", t or "")).strip()


# ══════════════════════════════════════════════════════════════════
# 来源 1：B站（免费，走首屏）
# ══════════════════════════════════════════════════════════════════

def search_bilibili(keyword: str, limit: int = 10, hint: str = "") -> list[dict]:
    url = f"{BILI_API}?keyword={urllib.parse.quote(keyword)}"
    try:
        d = _get_json(url, headers={"Referer": "https://www.bilibili.com"},
                      timeout=8, direct=True)
    except Exception as e:
        print(f"[Relink] B站搜索失败({keyword}): {e}")
        return []
    if d.get("code") != 0:
        print(f"[Relink] B站返回 {d.get('code')} {d.get('message')}")
        return []

    out: list[dict] = []
    min_play = _min_bili_play()
    for g in d.get("data", {}).get("result") or []:
        if g.get("result_type") != "video":
            continue
        for v in g.get("data") or []:
            bvid = v.get("bvid")
            if not bvid:
                continue
            play = int(v.get("play") or 0)
            if play < min_play:
                continue          # 低播放的多是随手拍/低质搬运，直接丢弃
            out.append({
                "source": "bilibili",
                "url": f"https://www.bilibili.com/video/{bvid}",
                "title": _clean(v.get("title") or ""),
                "author": _clean(v.get("author") or ""),
                "play": play,
                "duration": v.get("duration") or "",
                "pubdate": v.get("pubdate") or 0,
                "snippet": _clean(v.get("description") or "")[:100],
                "hint": hint,       # 来自哪条查询（live/cover/mv），AI 挂了时用它兜底分类
            })
            if len(out) >= limit:
                return out
    return out


# ══════════════════════════════════════════════════════════════════
# 来源 2：抖音
#   主通道：DeepSeek Search（国内直连、0.5s、¥5/千次、支持 site: 语法）
#   备用：  Tavily（国外站，7s 起且偶发 SSL 握手超时，配了 key 才走）
# ══════════════════════════════════════════════════════════════════

# 抖音网页的 <title> 经常是这些模板词，没有任何信息量
_GENERIC_TITLES = ("相关视频", "首页", "加载中", "精选", "热门分类", "抖音", "推荐")


def _looks_generic(title: str) -> bool:
    t = (title or "").strip()
    if len(t) < 4:
        return True
    return any(t.startswith(g) for g in _GENERIC_TITLES)


def _douyin_url(raw: str) -> str:
    """抖音结果 URL 归一化：去 #锚点 / ?query；只要单条内容页。"""
    u = (raw or "").split("#")[0].split("?")[0].rstrip("/")
    m = re.search(r"douyin\.com/(?:video|note|shipin)/\d+", u)
    return f"https://{m.group(0)}" if m else ""


def _douyin_item(url: str, title: str, snippet: str, hint: str) -> dict:
    return {
        "source": "douyin",
        "url": url,
        "title": title[:80],
        "author": "",
        "play": 0,
        "duration": "",
        "pubdate": 0,
        "snippet": snippet[:100],
        "hint": hint,
    }


def _search_douyin_deepseek(keyword: str, limit: int, hint: str) -> list[dict]:
    k = keys()["deepseek"]
    if not k:
        return []
    body = {
        "query": f"{keyword} site:douyin.com",
        "count": min(20, max(limit * 2, 8)),
        "need_content": False,
    }
    d = None
    # 走系统代理时偶发 "Tunnel connection failed: 502"，重试两次基本都能过
    for attempt in (1, 2):
        try:
            d = _post_json(DEEPSEEK_SEARCH_API, body,
                           headers={"Authorization": f"Bearer {k}"}, timeout=8)
            break
        except Exception as e:
            print(f"[Relink] 抖音(DeepSeek Search)失败({keyword}) 第{attempt}次: {e}")
            time.sleep(0.4 * attempt)
    if d is None:
        return []

    out, seen = [], set()
    for r in d.get("results") or []:
        u = _douyin_url(r.get("url") or "")
        if not u or u in seen:
            continue
        seen.add(u)
        title = _clean(r.get("title") or "")
        snippet = _clean(r.get("snippet") or "") or _clean(r.get("summary") or "")
        # 标题是"相关视频/首页"这种模板时，拿摘要开头顶上——否则列表里一行全是同样的字
        if _looks_generic(title):
            title = (snippet[:40] or "抖音视频").strip()
        out.append(_douyin_item(u, title, snippet, hint))
        if len(out) >= limit:
            break
    return out


def _search_douyin_tavily(keyword: str, limit: int, hint: str) -> list[dict]:
    k = keys()["tavily"]
    if not k:
        return []
    payload = {
        "api_key": k,
        "query": keyword,
        "max_results": max(limit, 6),
        "search_depth": "basic",
        "include_domains": ["douyin.com"],
    }
    d = None
    for attempt in (1, 2):                 # Tavily 偶发 SSL 握手超时，重试一次
        try:
            d = _post_json(TAVILY_API, payload, timeout=10)
            break
        except Exception as e:
            print(f"[Relink] 抖音(Tavily)搜索失败({keyword}) 第{attempt}次: {e}")
    if d is None:
        return []

    out, seen = [], set()
    for r in d.get("results") or []:
        u = _douyin_url(r.get("url") or "")
        if not u or u in seen:
            continue
        seen.add(u)
        title = _clean(r.get("title") or "")
        title = re.sub(r"\s*[-—]\s*抖音$", "", title).strip()   # 去掉页面标题模板后缀
        snippet = _clean(r.get("content") or "")
        out.append(_douyin_item(u, title, snippet, hint))
        if len(out) >= limit:
            break
    return out


def search_douyin(keyword: str, limit: int = 6, hint: str = "") -> list[dict]:
    out = _search_douyin_deepseek(keyword, limit, hint)
    if out:
        return out
    return _search_douyin_tavily(keyword, limit, hint)


# ══════════════════════════════════════════════════════════════════
# DeepSeek：规划搜索词 / 归类打分
# ══════════════════════════════════════════════════════════════════

def _chat(messages: list[dict], max_tokens: int = 900, timeout: int = 60,
          effort: str = "low") -> str:
    """effort=low 是实测结论：归类同一批 17 条，default(high) 11.6s vs low 4.8s，
    输出长度与质量无差别。这个任务是简单分类，不值得让它深度思考。"""
    k = keys()["deepseek"]
    if not k:
        raise RuntimeError("no deepseek key")
    d = _post_json(DEEPSEEK_API, {
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "effort": effort,
    }, headers={"Authorization": f"Bearer {k}"}, timeout=timeout)
    return (d.get("choices") or [{}])[0].get("message", {}).get("content") or ""


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i:
        text = text[i:j + 1]
    return json.loads(text)


# 模型偶尔会吐出畸形 JSON（字符串里插了未转义引号、或被截断）。
# 与其整批丢弃退化成规则版，不如按对象逐个抢救。
_ITEM_RE = re.compile(
    r'\{\s*"i"\s*:\s*(\d+)\s*,\s*"cat"\s*:\s*"([a-z]+)"\s*,'
    r'\s*"score"\s*:\s*(\d+)\s*,\s*"blurb"\s*:\s*"([^"]*)"\s*\}'
)


def _salvage_items(text: str) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for m in _ITEM_RE.finditer(text or ""):
        out[int(m.group(1))] = {
            "i": int(m.group(1)), "cat": m.group(2),
            "score": int(m.group(3)), "blurb": m.group(4),
        }
    return out


def _rule_queries(title: str, artist: str, scope: str = "song") -> dict:
    """scope=song 以歌为核心；scope=artist 只拿歌手名搜该歌手的现场/翻唱/MV。"""
    if scope == "artist":
        return {
            "live": [f"{artist} 现场", f"{artist} 演唱会"],
            "cover": [f"{artist} 翻唱", f"{artist} 歌曲 翻唱"],
            "mv": [f"{artist} MV"],
        }
    return {
        "live": [f"{title} {artist} 现场", f"{title} 演唱会 live"],
        "cover": [f"{title} {artist} 翻唱", f"{title} 吉他弹唱 翻唱"],
        "mv": [f"{title} {artist} MV"],
    }


def plan_queries(title: str, artist: str, scope: str = "song") -> dict:
    """AI 规划搜索词；失败退回规则版。"""
    fallback = _rule_queries(title, artist, scope)
    if scope == "artist":
        ask = (
            f"歌手「{artist}」。请分别给出适合在 B站/抖音 搜索的短查询词：\n"
            "- live: 2 条，找这位歌手的现场演出（演唱会/音乐节/不插电等）\n"
            "- cover: 2 条，找别人翻唱这位歌手的歌（不同歌手/乐器改编/清唱等）\n"
            "- mv: 1 条，找这位歌手的官方 MV\n"
        )
    else:
        ask = (
            f"歌曲《{title}》，歌手 {artist}。\n"
            "请分别给出适合在 B站/抖音 搜索的短查询词：\n"
            "- live: 2 条，找这首歌的现场版（演唱会/音乐节/不插电等）\n"
            "- cover: 2 条，找高质量翻唱（不同歌手/乐器改编/清唱等）\n"
            "- mv: 1 条，找官方 MV\n"
        )
    try:
        content = _chat([
            {"role": "system", "content": "你是中文音乐检索助手。只输出 JSON，不要解释。"},
            {"role": "user", "content":
             ask +
             'JSON 格式：{"live":["...","..."],"cover":["...","..."],"mv":["..."]}\n'
             "要求：每条不超过 20 字，不要加引号或多余符号。"},
        ], max_tokens=800, timeout=25)
        d = _parse_json(content)
        out: dict[str, list[str]] = {}
        for key in ("live", "cover", "mv"):
            vals = [str(x).strip() for x in (d.get(key) or []) if str(x).strip()]
            if vals:
                out[key] = vals[:1] if key == "mv" else vals[:2]
        if out.get("live") and out.get("cover"):
            out.setdefault("mv", fallback["mv"])
            return out
    except Exception as e:
        print(f"[Relink] DeepSeek 规划搜索词失败，改用规则版: {e}")
    return fallback


def _rule_cat(item: dict) -> str:
    t = ((item.get("title") or "") + " " + (item.get("snippet") or "")).lower()
    has_live = any(w in t for w in LIVE_WORDS)
    has_cover = any(w in t for w in COVER_WORDS)
    has_mv = any(w in t for w in MV_WORDS)

    if has_live and not has_cover:
        return "live"
    if has_cover and not has_live:
        return "cover"
    if has_mv:
        return "mv"
    if has_live and has_cover:
        return "live" if t.find("现场") < t.find("翻唱") else "cover"
    return ""          # 无强信号：交给调用方决定（hint 或 AI）


def _rule_score(item: dict, cat: str) -> int:
    score = 50
    play = item.get("play") or 0
    # 播放量权重给足：群众的播放/点赞是最稳的质量信号（B站能拿到，抖音拿不到）
    if play >= 5_000_000:
        score += 40
    elif play >= 1_000_000:
        score += 34
    elif play >= 300_000:
        score += 27
    elif play >= 100_000:
        score += 22
    elif play >= 10_000:
        score += 14
    elif play >= 1000:
        score += 6
    t = (item.get("title") or "").lower()
    if cat == "live" and any(w in t for w in ("现场", "live", "演唱会")):
        score += 8
    if cat == "cover" and any(w in t for w in ("翻唱", "cover", "弹唱")):
        score += 8
    if cat == "mv" and any(w in t for w in MV_WORDS):
        score += 10
    if item.get("source") == "bilibili":
        score += 3
    return min(99, score)


def label_rule(items: list[dict]) -> list[dict]:
    """规则版归类打分（无 AI 时用，也给 AI 版垫底）。
    标题没有强关键词时，用「这条结果来自哪条查询」兜底——抖音标题经常只有
    `#周杰伦演唱会##live` 这种标签、或者干脆没有关键词，否则会被一律塞进 other。"""
    for it in items:
        it["cat"] = _rule_cat(it) or it.get("hint") or "other"
        it["score"] = _rule_score(it, it["cat"])
        it["blurb"] = ""
    return items


def _refine_cat(item: dict, ai_cat: str) -> str:
    """AI 归类之后再按强关键词校正一次。

    实测 AI 会把「周杰伦本人演唱会的现场片段」误判成 other 并打低分，导致
    现场版里一条 B站 都不剩（全是抖音）。标题里有明确信号时，规则比 AI 稳：
      - 同时有 现场/演唱会 和 翻唱/cover → 本质是翻唱（现场翻唱）
      - 只有 现场/演唱会/live    → 现场版
      - 只有 翻唱/cover/弹唱     → 翻唱
    没有强关键词时才信任 AI。
    """
    t = ((item.get("title") or "") + " " + (item.get("snippet") or "")).lower()
    has_live = any(w in t for w in LIVE_WORDS)
    has_cover = any(w in t for w in COVER_WORDS)

    if has_live and has_cover:
        return "cover" if any(w in t for w in ("翻唱", "cover")) else "live"
    if has_live:
        return "live"
    if has_cover:
        return "cover"
    return ai_cat


def label_ai(title: str, artist: str, items: list[dict],
             scope: str = "song") -> tuple[list[dict], bool]:
    """在规则版基础上用 DeepSeek 复核。返回 (items, 是否成功用了 AI)。"""
    label_rule(items)
    if not items or not keys()["deepseek"]:
        return items, False

    lines = [
        f'{i}. [{SRC_LABEL.get(it["source"], it["source"])}] '
        f'标题：{it["title"][:60]}｜UP主：{it.get("author") or "-"}｜'
        f'播放：{it.get("play") or 0}｜简介：{(it.get("snippet") or "")[:50]}'
        for i, it in enumerate(items)
    ]
    if scope == "artist":
        head = f"歌手「{artist}」。下面是关于这位歌手的候选视频，请分类并打分。"
        rel = "是否确为这位歌手的演出/作品（跟这位歌手无关的串烧、盘点要打低分）"
        cover_desc = "cover=翻唱类：这位歌手翻唱/改编别人的歌，或别人翻唱这位歌手的歌"
    else:
        head = f"歌曲《{title}》（{artist}）。下面是候选视频，请分类并打分。"
        rel = "是否确为这首歌、且确实属于所判类别（串烧合集、同名不同歌要打低分）"
        cover_desc = "cover=翻唱或器乐改编（非原唱录音室版本；现场翻唱也算 cover）"
    prompt = (
        head + "\n\n"
        + "\n".join(lines) +
        "\n\n【分类】\n"
        "live=现场演出（演唱会/音乐节/不插电/现场收音；歌手本人的现场也算 live）\n"
        + cover_desc + "\n"
        "mv=官方发行的原版 MV / 官方音乐视频（官方音源配画面）\n"
        "other=纯音频音源、歌单合集、串烧、教程、歌词视频、无关内容\n"
        "\n【打分 0-100，按权重合成】\n"
        "- 相关性 40%：" + rel + "\n"
        "- 热度 35%：播放量是群众投票，同类别里播放量越高越靠前。"
        "参考档位：≥500万 接近满分；100万左右高分；10万中等；1万以下偏低；0 或未知按中位\n"
        "- 音质画质 25%：4K/高清/无损/官摄 > 普通翻录；画面糊、收音差的扣分\n"
        "\n【短评】不超过 14 个汉字，只能依据上面给出的标题/UP主/简介里已有的信息，"
        "严禁臆测视频里没有的画面或内容；不要照抄标题。\n"
        '只输出 JSON：{"items":[{"i":0,"cat":"live","score":88,"blurb":"..."}]}'
    )
    msgs = [
        {"role": "system", "content": "你是严谨的音乐视频筛选助手，只输出 JSON。"},
        {"role": "user", "content": prompt},
    ]
    # 失败重试：DeepSeek 走系统代理，实测偶发 "Tunnel connection failed: 502"，
    # 一次失败就退规则版太亏（规则版没有短评、抖音还容易被门槛滤掉）
    for attempt in (1, 2, 3):
        try:
            raw = _chat(msgs, max_tokens=4000, timeout=70)
            try:
                d = _parse_json(raw)
                got = {int(x["i"]): x for x in (d.get("items") or []) if "i" in x}
            except Exception:
                got = _salvage_items(raw)          # JSON 畸形：逐条抢救
                if got:
                    print(f"[Relink] 归类 JSON 畸形，抢救回 {len(got)}/{len(items)} 条")
            if not got:
                raise ValueError("empty items")
            for i, it in enumerate(items):
                x = got.get(i)
                if not x:
                    continue
                if x.get("cat") in GROUP_LABEL:
                    it["cat"] = x["cat"]
                try:
                    it["score"] = max(0, min(100, int(x.get("score", it["score"]))))
                except Exception:
                    pass
                blurb = str(x.get("blurb") or "").strip()
                if blurb:
                    it["blurb"] = blurb[:24]
            # AI 归类之后再按强关键词校正一次（规则命中时规则优先）
            for it in items:
                it["cat"] = _refine_cat(it, it["cat"])
            return items, True
        except Exception as e:
            print(f"[Relink] DeepSeek 归类失败(第{attempt}次): {e}")
            time.sleep(0.8 * attempt)      # 502 是瞬时抖动，稍等再试
    return items, False


# ══════════════════════════════════════════════════════════════════
# 组装
# ══════════════════════════════════════════════════════════════════

def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in items:
        if it["url"] in seen:
            continue
        seen.add(it["url"])
        out.append(it)
    return out


def _pre_rank(item: dict, match: str) -> float:
    """候选粗排：相关度优先于播放量。

    只用播放量排序会出问题——实测《Mojito》时，"周杰伦很少唱过的歌 串烧合集"
    （百万播放但跟这首歌无关）挤掉了真正的演唱会现场片段。所以：
      标题里含匹配词（歌名 / 歌手名）+40 / 含现场·翻唱·MV 关键词 +20 / 播放量按 log 加权

    match：scope=song 传歌名，scope=artist 传歌手名。
    """
    t = (item.get("title") or "").lower()
    s = 0.0
    if match and match.lower() in t:
        s += 40
    if any(w in t for w in LIVE_WORDS + COVER_WORDS + MV_WORDS):
        s += 20
    s += math.log10((item.get("play") or 0) + 1) * 7      # 百万播放 ≈ +42
    if item.get("source") == "bilibili":
        s += 2
    return s


def _assemble(song_id: str, title: str, artist: str, items: list[dict],
              used_ai: bool, t0: float, pending: bool, scope: str = "song") -> dict:
    groups = []
    for key in GROUP_ORDER:
        bucket = [it for it in items if it["cat"] == key]
        if not bucket:
            continue
        picked = []
        for src in ("bilibili", "douyin"):          # 来源优先级：B站 > 抖音
            same = sorted([b for b in bucket if b["source"] == src],
                          key=lambda x: x.get("score", 0), reverse=True)
            # B站 是主源，门槛比抖音松一点，但也不能放进 0 分噪音
            if src == "bilibili":
                same = [b for b in same if b.get("score", 0) >= (50 if key == "other" else 25)]
            else:
                same = [b for b in same if b.get("score", 0) >= (60 if key == "other" else 30)]
            picked.extend(same[:PER_SRC_LIMIT.get(key, 2)])
        picked = picked[:GROUP_MAX.get(key, 99)]    # MV 只留 1 条
        if picked:
            groups.append({
                "key": key, "label": GROUP_LABEL[key],
                "items": [{
                    "title": it["title"], "url": it["url"],
                    "source": it["source"], "source_label": SRC_LABEL[it["source"]],
                    "author": it.get("author") or "",
                    "play": it.get("play") or 0,
                    "duration": it.get("duration") or "",
                    "blurb": it.get("blurb") or "",
                    "score": it.get("score", 0),
                } for it in picked],
            })

    k = keys()
    notes = []
    if not k["deepseek"]:
        notes.append("未配置 DeepSeek key：只能搜 B站，且用规则排序（无 AI 短评、无抖音）")
    if not items:
        mp = _min_bili_play()
        notes.append(f"没搜到结果（B站已过滤播放量 < {mp} 的视频，可在 config.json 调 min_bili_play）")

    return {
        "song": {"id": song_id, "title": title, "artist": artist},
        "scope": scope,
        "ai": used_ai,
        "pending": pending,
        "total": sum(len(g["items"]) for g in groups),
        "groups": groups,
        "notes": notes,
        "took_ms": int((time.time() - t0) * 1000),
        "fetched_at": int(time.time()),
    }


# ══════════════════════════════════════════════════════════════════
# 磁盘缓存（<音乐目录>/相关视频/<原文件名>.json）
# ══════════════════════════════════════════════════════════════════

def relinks_dir() -> Path:
    return scanner.MUSIC_DIR / REL_DIR_NAME


def artist_relinks_dir() -> Path:
    """歌手维度的检索结果单独放子目录，避免和歌曲结果的文件名撞车。"""
    return relinks_dir() / "歌手"


def _safe_stem(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "_", name or "").strip().rstrip(".")
    return (s or "untitled")[:80]


def _cache_key(scope: str, ident: str) -> str:
    """歌曲和歌手可能同名（歌名=歌手名），缓存 key 必须带 scope 前缀。"""
    return f"{scope}:{ident}"


def _scan_disk(dirpath: Path, scope: str) -> None:
    if not dirpath.exists():
        return
    for f in dirpath.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        sid = (data.get("song") or {}).get("id")
        if sid:
            _disk_index[_cache_key(data.get("scope") or scope, sid)] = f


def _rebuild_disk_index() -> None:
    global _disk_index_built
    _disk_index.clear()
    _scan_disk(relinks_dir(), "song")
    _scan_disk(artist_relinks_dir(), "artist")
    _disk_index_built = True


def _disk_path_for(scope: str, ident: str, filepath: str, name: str) -> Path:
    """歌曲 → <相关视频>/<原文件名>.json；歌手 → <相关视频>/歌手/<歌手名>.json"""
    base = _safe_stem(Path(filepath).stem if (scope == "song" and filepath) else name)
    d = artist_relinks_dir() if scope == "artist" else relinks_dir()
    f = d / f"{base}.json"
    if f.exists():
        try:
            meta = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        same = ((meta.get("song") or {}).get("id") == ident
                and (meta.get("scope") or "song") == scope)
        if not same:
            i = 2
            while (d / f"{base}_{i}.json").exists():
                i += 1
            f = d / f"{base}_{i}.json"
    return f


def _disk_read(key: str) -> dict | None:
    """读盘。返回 None 表示没有 / 已失效（需要重搜）。"""
    with _lock:
        if not _disk_index_built:
            _rebuild_disk_index()
        f = _disk_index.get(key)
    if not f or not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("version") != DISK_VERSION:
        return None

    # 能力升级检测：当时没 key（规则版/无抖音），现在有了 → 旧结果不值钱了，重搜
    caps = data.get("caps") or {}
    now = status()
    if now["deepseek"] and not caps.get("deepseek"):
        return None
    if now["tavily"] and not caps.get("tavily"):
        return None

    data["pending"] = False
    data["from_disk"] = True
    data["took_ms"] = 0
    data.setdefault("scope", key.split(":", 1)[0])   # 老文件没这个字段
    data.setdefault("fetched_at", int(f.stat().st_mtime))
    return data


def _disk_write(key: str, scope: str, ident: str, filepath: str,
                name: str, data: dict, partial: bool = False) -> None:
    try:
        d = artist_relinks_dir() if scope == "artist" else relinks_dir()
        d.mkdir(parents=True, exist_ok=True)
        f = _disk_path_for(scope, ident, filepath, name)
        payload = {
            "version": DISK_VERSION,
            "scope": scope,
            # partial=True：只搜到首屏（B站）就写盘了，抖音/AI 还没补
            "partial": partial,
            "song": data["song"],
            "ai": data["ai"],
            "caps": status(),
            "fetched_at": data.get("fetched_at") or int(time.time()),
            "total": data["total"],
            "groups": data["groups"],
            "notes": data["notes"],
        }
        f.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        with _lock:
            _disk_index[key] = f
    except Exception as e:
        print(f"[Relink] 写盘失败 {key}: {e}")


def clear_cache(song_id: str | None = None) -> None:
    """清内存与索引（不动磁盘）。切曲库 / 换 key 时调用。"""
    global _disk_index_built
    with _lock:
        if song_id:
            _mem.pop(song_id, None)
        else:
            _mem.clear()
        _disk_index.clear()
        _disk_index_built = False


def _mem_get(song_id: str) -> dict | None:
    with _lock:
        d = _mem.get(song_id)
        if d is None:
            return None
        if time.time() - d.get("_ts", 0) > MEM_TTL:
            _mem.pop(song_id, None)
            return None
        _mem.move_to_end(song_id)
        return d


def _mem_put(song_id: str, data: dict) -> None:
    with _lock:
        _mem[song_id] = dict(data, _ts=time.time())
        _mem.move_to_end(song_id)
        while len(_mem) > MEM_MAX:
            _mem.popitem(last=False)      # 淘汰最久未用的，内存不无限涨


# ══════════════════════════════════════════════════════════════════
# 两段式主流程
# ══════════════════════════════════════════════════════════════════

def _collect_fast(title: str, artist: str, scope: str = "song") -> list[dict]:
    """同步阶段：规则查询词打 B站三路（现场/翻唱/MV）。约 0.6-1.5 秒。"""
    q = _rule_queries(title, artist, scope)
    jobs = [("live", q["live"][0]), ("cover", q["cover"][0]), ("mv", q["mv"][0])]
    items: list[dict] = []
    ex = ThreadPoolExecutor(max_workers=3)
    try:
        futs = [ex.submit(search_bilibili, kw, 10, hint) for hint, kw in jobs]
        done, pending = futures_wait(futs, timeout=SEARCH_BUDGET_FAST)
        for f in done:
            try:
                items.extend(f.result() or [])
            except Exception as e:
                print(f"[Relink] 首屏检索异常: {e}")
        if pending:
            print(f"[Relink] 首屏 {len(pending)} 路超预算，先用已返回的")
    finally:
        ex.shutdown(wait=False)          # 不等慢请求，避免拖住首屏
    return _dedupe(items)


def _finish(key: str, scope: str, ident: str, title: str, artist: str,
            filepath: str, base_items: list[dict], t0: float) -> None:
    """后台阶段：AI 规划更准的词 → B站补一轮 + 抖音双查询 → AI 归类 → 落盘 + 进内存。"""
    try:
        q = plan_queries(title, artist, scope)
        print(f"[Relink] 搜索词规划完成 {time.time() - t0:.1f}s: {q}")
        jobs = [("bilibili", q["live"][0], "live"), ("bilibili", q["cover"][0], "cover"),
                ("bilibili", q["mv"][0], "mv"),
                ("douyin", q["live"][0], "live"), ("douyin", q["cover"][0], "cover")]

        extra: list[dict] = []
        ex = ThreadPoolExecutor(max_workers=5)
        try:
            futs = [
                ex.submit(search_bilibili if s == "bilibili" else search_douyin, k, 10, hint)
                for s, k, hint in jobs
            ]
            # 总预算制：网络差时宁可少一路结果，也不让补齐无限拖
            done, pending = futures_wait(futs, timeout=SEARCH_BUDGET_FULL)
            for f in done:
                try:
                    extra.extend(f.result() or [])
                except Exception as e:
                    print(f"[Relink] 后台检索异常: {e}")
            if pending:
                print(f"[Relink] {len(pending)} 路检索超预算，先用已返回的")
        finally:
            ex.shutdown(wait=False)

        all_items = _dedupe(base_items + extra)
        # 固定配额：B站保 11 条、抖音保 6 条。
        # 不能按「总上限 - 抖音数」算 B站配额 —— 抖音两查询回来十几条时会把 B站挤光。
        match = title if scope == "song" else artist
        bili = sorted([x for x in all_items if x["source"] == "bilibili"],
                      key=lambda x: _pre_rank(x, match), reverse=True)[:BILI_KEEP]
        dy = [x for x in all_items if x["source"] == "douyin"][:DOUYIN_KEEP]
        cands = bili + dy
        print(f"[Relink] 候选 {len(all_items)} 条（B站{len(bili)}/抖音{len(dy)}），"
              f"检索用时 {time.time() - t0:.1f}s")

        cands, used_ai = label_ai(title, artist, cands, scope)
        full = _assemble(ident, title, artist, cands, used_ai, t0,
                         pending=False, scope=scope)
        if keys()["deepseek"] and not used_ai:
            full["notes"].append("AI 归类这次没成功（网络抖动），已按规则归类，可点刷新重试")
        _mem_put(key, full)
        _disk_write(key, scope, ident, filepath, match, full)
        print(f"[Relink] 补齐完成 {key}: {full['total']} 条, ai={used_ai}")
    except Exception as e:                                     # noqa: BLE001
        print(f"[Relink] 后台补齐失败 {key}: {e}")
    finally:
        with _lock:
            _jobs.pop(key, None)      # 任务态数据随之释放，不常驻内存


def _resume(key: str, scope: str, ident: str, title: str, artist: str,
            filepath: str, fast: dict) -> None:
    """磁盘上是 partial（只搜到首屏）→ 重新排一个后台补齐任务。

    已经有任务在跑就不重复排（避免用户连点造成多线程抢同一首歌）。
    """
    with _lock:
        if key in _jobs or len(_jobs) >= MAX_JOBS:
            return
        _jobs[key] = {"fast": fast, "t0": time.time()}
    threading.Thread(target=_finish,
                     args=(key, scope, ident, title, artist, filepath, [], time.time()),
                     daemon=True).start()
    print(f"[Relink] 检测到未完成的结果，后台续跑 {key}")


def get_result(ident: str, title: str, artist: str, filepath: str = "",
               force: bool = False, scope: str = "song") -> dict:
    """三级缓存入口。pending=True 表示后台还在补抖音/AI 排序，前端稍后再取。

    scope=song：ident 是 song_id，title/artist 是歌名歌手
    scope=artist：ident 是歌手名，title 留空，按歌手维度搜
    """
    key = _cache_key(scope, ident)
    with _lock:
        job = _jobs.get(key)
        if job and not force:
            d = dict(job["fast"])
            d["pending"] = True
            d["source"] = "network"
            return d

    if not force:
        m = _mem_get(key)
        if m:
            d = dict(m)
            d.pop("_ts", None)
            d["source"] = "memory"
            d["took_ms"] = 0          # 缓存命中不算搜索耗时
            if d.get("partial"):      # 内存里也是半成品 → 继续补齐
                d["pending"] = True
                _resume(key, scope, ident, title, artist, filepath, d)
            return d

        disk = _disk_read(key)
        if disk:
            _mem_put(key, disk)
            d = dict(disk)
            d.pop("_ts", None)
            d["source"] = "disk"
            if d.get("partial"):
                # 上次只搜完首屏就中断了：先把这份给用户，同时续跑后台补齐
                d["pending"] = True
                _resume(key, scope, ident, title, artist, filepath, d)
            return d

    # 冷启动：同步出首屏
    t0 = time.time()
    items = _collect_fast(title, artist, scope)
    fast = _assemble(ident, title, artist, label_rule(list(items)),
                     used_ai=False, t0=t0, pending=True, scope=scope)

    # 首屏立刻落盘（partial）。关窗、退出应用、后台线程异常都不会让这批 B站结果白搜；
    # 下次打开会先返回这份，同时自动续跑后台补齐。
    try:
        _disk_write(key, scope, ident, filepath,
                    title if scope == "song" else artist, fast, partial=True)
    except Exception as e:
        print(f"[Relink] 首屏落盘失败 {key}: {e}")

    with _lock:
        if len(_jobs) >= MAX_JOBS:
            # 队列已满：这次只给 B站结果，不排后台（避免线程堆积）
            fast["pending"] = False
            fast["source"] = "network"
            fast["notes"] = fast["notes"] + ["当前搜索任务较多，抖音/AI 结果稍后再试"]
            return fast
        _jobs[key] = {"fast": fast, "t0": t0}

    threading.Thread(target=_finish,
                     args=(key, scope, ident, title, artist, filepath, items, t0),
                     daemon=True).start()

    d = dict(fast)
    d["source"] = "network"
    return d
