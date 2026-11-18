# 曲库画像（彩蛋功能）—— 本地统计 + DeepSeek 打标 + 随机推荐
#
# 为什么要分批：曲库常有几百上千首，一次性塞给模型既超上下文又贵。
# 工作流：
#   ① 读标签缓存（<音乐目录>/曲库分析/标签.json），只把"没打过标"的歌送去分类
#   ② 每批 45 首 → DeepSeek 返回 {序号: [标签]} → 立即合并写盘（中断也不白跑）
#   ③ 本地汇总成画像：风格占比 / 标签权重 / 常听歌手 / 基础统计
#   ④ 推荐：口味画像 + 随机主题 → 8 首候选 → 逐条去网易云搜索校验，给真实链接
#
# 只把「歌名 + 歌手」发给模型，不上传音频，也不上传文件路径。

import hashlib
import json
import os
import random
import re
import threading
import time
import urllib.parse
from collections import Counter
from pathlib import Path

import scanner
import relinks
import artist_info

VERSION = 1
BATCH = 45                 # 每批歌曲数。45 ≈ 700 输出 token，稳定且不易截断
MAX_RETRY = 1

# 固定词表：不约束的话模型会给出"华语流行男声抒情"这种没法聚合的标签
TAXONOMY = [
    "流行", "摇滚", "民谣", "电子", "说唱", "R&B", "爵士", "古典", "金属", "朋克",
    "后摇", "国风", "古风", "二次元", "影视原声", "纯音乐", "轻音乐", "舞曲",
    "乡村", "灵魂乐", "放克", "雷鬼", "世界音乐", "儿童", "其他",
]
_FALLBACK_TAG = "其他"

# 推荐的随机主题：每次换一批时抽一个，避免总是同一批"安全牌"
THEMES = [
    "雨夜通勤", "周末清晨", "深夜独处", "公路旅行", "咖啡馆下午",
    "跑步", "旧时光回忆", "下雨的午后", "睡前的安静时刻", "整理房间",
]


# ══════════════════════════════════════════════════════════════════
# 存储
# ══════════════════════════════════════════════════════════════════

def _dir() -> Path:
    return scanner.MUSIC_DIR / "曲库分析"


def _labels_path() -> Path:
    return _dir() / "标签.json"


def _profile_path() -> Path:
    return _dir() / "画像.json"


def _atomic_write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: Path) -> dict:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[Insights] 读取失败 {path.name}: {e}")
    return {}


def _source_key(songs: list) -> str:
    """曲库指纹：歌单变化（增删/改名）后，画像要标记为过期"""
    h = hashlib.sha1()
    for s in sorted(songs, key=lambda x: x.id):
        h.update(f"{s.id}|{s.title}|{s.artist}".encode("utf-8"))
    return h.hexdigest()[:16]


# ══════════════════════════════════════════════════════════════════
# 任务状态（同一时刻只允许一个分析任务）
# ══════════════════════════════════════════════════════════════════

_lock = threading.Lock()
_job: dict = {
    "running": False, "stage": "", "done": 0, "total": 0, "progress": 0,
    "error": "", "started_at": 0, "finished_at": 0, "labeled": 0,
}


def _set(**kw) -> None:
    with _lock:
        _job.update(kw)


def job() -> dict:
    with _lock:
        return dict(_job)


# ══════════════════════════════════════════════════════════════════
# LLM
# ══════════════════════════════════════════════════════════════════

def has_key() -> bool:
    try:
        return bool(relinks.keys()["deepseek"])
    except Exception:
        return False


def _classify_batch(items: list[tuple[int, str, str]]) -> dict[int, list[str]]:
    """items = [(序号, 歌名, 歌手)] → {序号: [标签]}"""
    lines = "\n".join(f"{i}|{t}|{a}" for i, t, a in items)
    prompt = (
        "你是音乐曲库分类器。给下面每首歌打 1-3 个风格标签。\n"
        f"标签只能从这个词表里选：{'、'.join(TAXONOMY)}\n"
        "规则：按音乐风格归类（不是语言、不是年代）；"
        "一首歌最多 3 个标签，拿不准就选最接近的，实在不行用「其他」。\n"
        '只输出 JSON，格式：{"labels":{"1":["流行"],"2":["民谣","流行"]}}，'
        "序号必须与输入完全一致，不要输出任何解释。\n"
        f"歌曲列表（序号|歌名|歌手）：\n{lines}"
    )
    raw = relinks._chat(
        [{"role": "user", "content": prompt}],
        max_tokens=2200, timeout=90, effort="low", temperature=0,
    )
    if not (raw or "").strip():
        raise RuntimeError("模型返回为空")
    out = _parse_labels(raw)
    if not out:
        raise RuntimeError("模型返回无法解析")
    return out


# ── 容错解析：模型偶尔在字符串里塞未转义引号，整段 json.loads 会崩。
# 按大括号配对切出每个对象，逐个尝试；失败再用正则抠字段。
def _objects(text: str) -> list[str]:
    """提取所有完整的大括号块（栈式）。
    ⚠️ 不能用"最外层闭合"的写法：模型输出被截断时外层永远不闭合，
    会一个对象都拿不到——而实际上前面若干个 item 是完好的。"""
    out, stack = [], []
    for i, ch in enumerate(text or ""):
        if ch == "{":
            stack.append(i)
        elif ch == "}" and stack:
            out.append(text[stack.pop():i + 1])
    return out


def _field(obj: str, name: str) -> str:
    m = re.search(r'"%s"\s*:\s*"([^"]*)"' % name, obj)
    return (m.group(1) if m else "").strip()


def _parse_labels(raw: str) -> dict[int, list[str]]:
    """{ "1": ["流行"] } —— 先整体解析，失败再按对象抠"""
    out: dict[int, list[str]] = {}
    try:
        data = relinks._parse_json(raw)
        labels = data.get("labels") or data
        if isinstance(labels, dict):
            for k, v in labels.items():
                try:
                    idx = int(k)
                except Exception:
                    continue
                tags = [str(x).strip() for x in (v if isinstance(v, list) else [v])]
                tags = [t for t in tags if t in TAXONOMY][:3]
                if tags:
                    out[idx] = tags
            if out:
                return out
    except Exception:
        pass
    # 兜底：正则扫 "3": ["流行","摇滚"] 这种片段
    for m in re.finditer(r'"(\d+)"\s*:\s*\[([^\]]*)\]', raw or ""):
        tags = [t.strip().strip('"') for t in m.group(2).split(",")]
        tags = [t for t in tags if t in TAXONOMY][:3]
        if tags:
            out[int(m.group(1))] = tags
    return out


def _parse_picks(raw: str) -> list[dict]:
    """{"picks":[{...}]} —— 逐个对象解析，坏一个不影响其它"""
    try:
        data = relinks._parse_json(raw)
        picks = data.get("picks")
        if isinstance(picks, list) and picks:
            return [p for p in picks if isinstance(p, dict) and p.get("title")]
    except Exception:
        pass
    picks = []
    for obj in _objects(raw or ""):
        title = _field(obj, "title")
        if not title:
            continue
        picks.append({
            "title": title,
            "artist": _field(obj, "artist"),
            "genre": _field(obj, "genre"),
            "reason": _field(obj, "reason"),
            "kind": _field(obj, "kind"),
        })
    return picks


# ══════════════════════════════════════════════════════════════════
# 分析
# ══════════════════════════════════════════════════════════════════

def analyze(songs: list, limit: int = 0) -> dict:
    with _lock:
        if _job["running"]:
            return {"started": True, "already": True}
        _job.update({
            "running": True, "stage": "准备", "done": 0, "total": 0, "progress": 0,
            "error": "", "started_at": int(time.time()), "finished_at": 0, "labeled": 0,
        })
    threading.Thread(target=_run, args=(list(songs), limit), daemon=True).start()
    return {"started": True}


def _run(songs: list, limit: int) -> None:
    try:
        if not has_key():
            _set(running=False, stage="", error="未配置 DeepSeek API Key",
                 finished_at=int(time.time()))
            return

        # ── ① 读缓存，找出没打过标的歌 ──
        cache = _read(_labels_path())
        labels: dict[str, list[str]] = cache.get("labels") or {}
        ids = {s.id for s in songs}
        labels = {k: v for k, v in labels.items() if k in ids}   # 丢掉已删歌曲
        todo = [s for s in songs if s.id not in labels]
        if limit > 0:
            todo = todo[:limit]

        _set(stage="分类", total=len(todo), done=0, progress=5, labeled=len(labels))
        failed_batches = 0
        batches = 0
        if not todo:
            _set(stage="汇总", progress=88)
        else:
            for start in range(0, len(todo), BATCH):
                chunk = todo[start:start + BATCH]
                batches += 1
                items = [(i + 1, s.title, s.artist) for i, s in enumerate(chunk)]
                got: dict[int, list[str]] = {}
                ok = False
                for attempt in range(MAX_RETRY + 1):
                    try:
                        got = _classify_batch(items)
                        ok = True
                        break
                    except Exception as e:
                        print(f"[Insights] 批次失败(第{attempt + 1}次): {e}")

                if ok:
                    for i, s in enumerate(chunk, start=1):
                        labels[s.id] = got.get(i) or [_FALLBACK_TAG]
                else:
                    # ⚠️ 失败的批次**不写标签**：写了就等于把"其他"永久缓存下来，
                    # 下次不会再重试，一次网络抖动会污染整库。
                    failed_batches += 1

                done = start + len(chunk)
                _set(done=done, progress=5 + int(80 * done / max(1, len(todo))),
                     labeled=len(labels))
                if ok:   # 失败的批次连文件都不碰，避免留下空缓存让人误判
                    _atomic_write(_labels_path(), {
                        "version": VERSION, "updated_at": int(time.time()), "labels": labels,
                    })

            if batches and failed_batches == batches:
                raise RuntimeError("分类请求全部失败：请检查 DeepSeek Key 与网络后重试")

        # ── ② 汇总 ──
        _set(stage="汇总", progress=90)
        profile = _build_profile(songs, labels)
        old = _read(_profile_path())
        if old.get("recommendations"):
            profile["recommendations"] = old["recommendations"]   # 保留上次推荐
        _atomic_write(_profile_path(), profile)

        _set(running=False, stage="完成", progress=100, done=len(todo),
             finished_at=int(time.time()))
    except Exception as e:
        _set(running=False, error=str(e), finished_at=int(time.time()))
        print(f"[Insights] 分析失败: {e}")


def _build_profile(songs: list, labels: dict[str, list[str]]) -> dict:
    genre = Counter()
    tag = Counter()
    for s in songs:
        tags = labels.get(s.id) or []
        for t in tags:
            tag[t] += 1
            if t != _FALLBACK_TAG:
                genre[t] += 1

    total_labels = sum(genre.values()) or 1
    genres = [{"name": k, "count": v, "pct": round(v * 100 / total_labels, 1)}
              for k, v in genre.most_common()]
    tags = [{"name": k, "count": v} for k, v in tag.most_common(16)]

    artist = Counter()
    for s in songs:
        for a in (s.artists or [s.artist]):
            artist[a] += 1

    total_sec = sum(s.duration or 0 for s in songs)
    stats = {
        "songs": len(songs),
        "artists": len(artist),
        "hours": round(total_sec / 3600, 1),
        "avg_minutes": round((total_sec / len(songs)) / 60, 1) if songs else 0,
        "lyrics_pct": round(sum(1 for s in songs if s.has_lrc) * 100 / len(songs), 1) if songs else 0,
        "labeled": sum(1 for s in songs if labels.get(s.id)),
        "unlabeled": sum(1 for s in songs if not labels.get(s.id)),
    }
    return {
        "version": VERSION,
        "generated_at": int(time.time()),
        "source_key": _source_key(songs),
        "stats": stats,
        "genres": genres,
        "tags": tags,
        "artists": [{"name": k, "count": v} for k, v in artist.most_common(12)],
    }


# ══════════════════════════════════════════════════════════════════
# 推荐
# ══════════════════════════════════════════════════════════════════

def _norm(text: str) -> str:
    return re.sub(r"[\s\-—_·•()（）\[\]【】,，.。!！?？'\"“”‘’]", "", (text or "").lower())


def _cover_of(song_id) -> str:
    """搜索接口的 album 里没有 picUrl（只有 id/size），要单独查详情才拿得到封面"""
    if not song_id:
        return ""
    try:
        d = artist_info._get_json(
            f"https://music.163.com/api/song/detail?ids=[{song_id}]", timeout=6)
        songs = d.get("songs") or []
        return ((songs[0].get("album") or {}).get("picUrl") or "") if songs else ""
    except Exception:
        return ""


def _verify(pick: dict) -> dict:
    """网易云搜索校验：确认这首歌真实存在，顺便拿封面和 id 做链接。
    查不到不算失败——给搜索链接兜底，标记 verified=False。"""
    q = f"{pick.get('title', '')} {pick.get('artist', '')}".strip()
    item = {
        "title": pick.get("title", "").strip(),
        "artist": pick.get("artist", "").strip(),
        "genre": pick.get("genre", ""),
        "reason": (pick.get("reason") or "").strip()[:80],
        "kind": pick.get("kind") if pick.get("kind") in ("safe", "adjacent", "explore") else "adjacent",
        "verified": False, "url": "", "cover": "",
    }
    if not q:
        return item
    try:
        d = artist_info._get_json(
            "https://music.163.com/api/search/get?s="
            + urllib.parse.quote(q) + "&type=1&limit=5", timeout=8)
        nt = _norm(item["title"])
        for s in (d.get("result") or {}).get("songs") or []:
            name = _norm(s.get("name", ""))
            artists = [a.get("name", "") for a in (s.get("artists") or [])]
            if nt and (name == nt or (nt in name and len(name) - len(nt) <= 4)):
                if any(_norm(x) in _norm(item["artist"]) or _norm(item["artist"]) in _norm(x)
                       for x in artists if x):
                    sid = s.get("id")
                    item.update({
                        "verified": True,
                        "url": f"https://music.163.com/#/song?id={sid}",
                        "cover": _cover_of(sid),
                    })
                    break
    except Exception as e:
        print(f"[Insights] 校验失败 {q}: {e}")

    if not item["url"]:
        item["url"] = ("https://music.163.com/#/search/m/?s="
                       + urllib.parse.quote(q) + "&type=1")
    item["bili"] = ("https://search.bilibili.com/all?keyword="
                    + urllib.parse.quote(q))
    return item


def _prompt(theme: str, genres: str, artists: str, fewer: list[str],
            titles: list[str], want: int, simple: bool = False) -> str:
    """两套提示词：正常版信息全，降级版更短。
    实测模型偶发把 JSON 截断/吐空，短提示词的完成率高很多。"""
    if simple:
        return (
            "根据口味画像推荐" f"{want} 首用户曲库里没有的华语歌。\n"
            f"口味：{genres}。\n"
            f"场景：{theme}。\n"
            f"不要推荐这些已有歌手：{'、'.join(fewer[:20])}。\n"
            '只输出 JSON：{"picks":[{"title":"","artist":"","genre":"","reason":"","kind":"safe"}]}'
        )
    return (
        "你在给一位用户做本地曲库的「可能想听」推荐。\n"
        f"他的口味画像：风格占比 {genres}；常听歌手 {artists}。\n"
        f"本次随机场景：{theme}。\n"
        f"请推荐 {want} 首他曲库里**没有**的歌（华语为主，可少量外语）。\n"
        "构成要求：约 1/3 同风格安全牌(kind=safe)、1/3 相邻风格(adjacent)、"
        "1/3 跨年代/冷门探索(explore)。\n"
        f"绝对不要推荐这些已有歌手：{'、'.join(fewer)}。\n"
        f"也不要推荐这些他已经在听的歌：{'、'.join(titles)}。\n"
        "每首给一句不超过 30 字的推荐理由（结合场景，不要空话）。\n"
        '只输出 JSON：{"picks":[{"title":"","artist":"","genre":"","reason":"","kind":"safe"}]}'
    )


def recommend(songs: list, count: int = 8) -> dict:
    profile = _read(_profile_path())
    if not profile.get("genres"):
        raise RuntimeError("还没有画像，先分析一次")
    if not has_key():
        raise RuntimeError("未配置 DeepSeek API Key")

    top_genres = "、".join(f"{g['name']}({g['pct']}%)" for g in profile["genres"][:8])
    top_artists = "、".join(a["name"] for a in profile["artists"][:12])

    # 已有歌手按**全库**算：画像里只有 top12，用它会把库里已有的歌手又推一遍
    ac: Counter = Counter()
    for s in songs:
        for a in (s.artists or [s.artist]):
            ac[a] += 1
    fewer = [a for a, _ in ac.most_common(60)]
    titles = [s.title for s in random.sample(songs, min(30, len(songs)))]
    theme = random.choice(THEMES)

    # 正常版要 count+4（去重后仍能凑够），失败两次后换短提示词再试
    picks: list[dict] = []
    attempts = [(False, 3, count + 4), (True, 2, count + 2)]
    for simple, tries, want in attempts:
        for i in range(tries):
            prompt = _prompt(theme, top_genres, top_artists, fewer, titles, want, simple)
            try:
                raw = relinks._chat([{"role": "user", "content": prompt}],
                                    max_tokens=3000, timeout=120, effort="low", temperature=1.0)
                if not (raw or "").strip():
                    print(f"[Insights] 推荐返回空（simple={simple} 第{i + 1}次）")
                    continue
                picks = _parse_picks(raw)
                if len(picks) >= 3:
                    break
                print(f"[Insights] 推荐解析不足 {len(picks)} 条 "
                      f"(raw_len={len(raw)} tail={raw[-60:]!r})")
            except Exception as e:
                print(f"[Insights] 推荐请求失败（simple={simple} 第{i + 1}次）: {e}")
        if len(picks) >= 3:
            break
    if not picks:
        raise RuntimeError("生成推荐失败，请再点一次")

    # 本地去重：模型仍可能给出曲库里已有的歌（同名 + 歌手重叠）
    items, seen = [], set()
    for p in picks:
        title_n, artist_n = _norm(p.get("title", "")), _norm(p.get("artist", ""))
        key = (title_n, artist_n)
        if not title_n or key in seen:
            continue
        seen.add(key)
        dup = any(
            _norm(s.title) == title_n and (
                artist_n in _norm(s.artist) or _norm(s.artist) in artist_n
                or any(_norm(a) == artist_n for a in (s.artists or []))
            )
            for s in songs
        )
        if dup:
            continue
        items.append(_verify(p))
        if len(items) >= count:
            break

    profile["recommendations"] = {
        "generated_at": int(time.time()),
        "theme": theme,
        "items": items,
    }
    _atomic_write(_profile_path(), profile)
    return profile["recommendations"]


# ══════════════════════════════════════════════════════════════════
# 读取（给前端）
# ══════════════════════════════════════════════════════════════════

def state(songs: list) -> dict:
    profile = _read(_profile_path())
    stale = bool(profile) and profile.get("source_key") != _source_key(songs)
    return {
        "has_key": has_key(),
        "job": job(),
        "profile": profile or None,
        "stale": stale,
        "songs": len(songs),
    }
