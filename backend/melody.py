"""旋律提取（V14）：人声轨 → 音高曲线 → 音符 → 按歌词句切分。

为什么必须用**分离后的人声轨**：实测对混音直接跑基频检测，pyin 会锁定到贝斯
（《晴天》中位 82Hz，而周杰伦人声在 130–260Hz），与人声轨的一致性只有 37%。
所以本模块只吃 `<音乐目录>/人声分离/<歌>_C|G/vocals.flac`。

音高检测优先级：
  1. **CREPE**（torchcrepe，SOTA 的卷积音高估计，GPU 上跑）
  2. **librosa.pyin**（兜底，纯 numpy/scipy，无 torch 也能用）

输出：音符序列（起始时间/时长/MIDI/音名如 A4/音分偏差）+ 按 LRC 句分组。
缓存：`<音乐目录>/旋律/<原文件名>.json`，一首歌只算一次。
"""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import numpy as np

_VENDOR = Path(__file__).parent / "vendor"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

# torchcrepe 的 load.py 会 `import torchaudio`（只用于读音频文件）。
# 我们的音频走 librosa 解码，不需要它，所以给个最小 stub —— 免得为了一行 import
# 去装 100MB 的 torchaudio。
import types as _types

if "torchaudio" not in sys.modules:
    try:
        import torchaudio  # noqa: F401
    except Exception:
        _stub = _types.ModuleType("torchaudio")

        def _no_load(*a, **k):
            raise RuntimeError("torchaudio 未安装；旋律模块直接传 numpy 音频")

        _stub.load = _no_load
        sys.modules["torchaudio"] = _stub

import scanner  # noqa: E402
import separator as stems_mod  # noqa: E402

# librosa 懒加载：它连带 numpy/scipy/audioread 一起进来要占几十 MB，
# 而只有点「旋律」时才用得上。启动时不该为它付内存。
_librosa = None


def _lb():
    global _librosa
    if _librosa is None:
        import librosa as _l
        _librosa = _l
    return _librosa


SR = 16000
HOP = 160                 # 16k/160 = 10ms 一帧
HOP_S = HOP / SR
FMIN, FMAX = 65.0, 1800.0   # 1800 约到 A6：女声哨音能到 D#6/E6，1000 会把整段截掉
CONF_MIN = 0.45           # CREPE 置信度阈值
MIN_NOTE = 0.07           # 短于 70ms 的音符丢掉
GAP_MERGE = 0.10          # 同音高、间隔 <100ms 的合并

DIR_NAME = "旋律"
ENGINE = "crepe-1800"    # 参数变了就升版本，让旧缓存自动重算

_lock = threading.RLock()
# 同一时刻只允许一个音高分析在跑。
# 原因：每次要把整首人声解码进内存（5 分钟 ≈ 19MB），还要占 GPU；
# 并发请求会让内存翻倍、GPU 互相抢，严重时显存直接打满。
# 排队期间会重新查一次磁盘缓存，所以重复点击不会算两遍。
_analyze_sem = threading.Semaphore(1)
_jobs: dict[str, dict] = {}


# ── 音高检测 ─────────────────────────────────────────────────────

def _f0_crepe(y: np.ndarray) -> tuple[np.ndarray, str]:
    import torch
    import torchcrepe

    device = "cuda" if torch.cuda.is_available() else "cpu"
    audio = torch.tensor(np.ascontiguousarray(y), dtype=torch.float32).unsqueeze(0)
    # 注意：这个版本的 torchcrepe 没有 verbose 参数，第二个返回值是 periodicity
    pitch, periodicity = torchcrepe.predict(
        audio, SR, hop_length=HOP, fmin=FMIN, fmax=FMAX,
        model="full", batch_size=2048, device=device, pad=True,
        return_periodicity=True,      # 默认只返回 pitch，必须显式要置信度
    )
    f0 = pitch.squeeze(0).cpu().numpy().astype(np.float64)
    p = periodicity.squeeze(0).cpu().numpy()
    f0[p < CONF_MIN] = np.nan
    return f0, f"crepe/{device}"


def _f0_pyin(y: np.ndarray) -> tuple[np.ndarray, str]:
    f0, _, _ = _lb().pyin(
        y, fmin=FMIN, fmax=FMAX, sr=SR,
        frame_length=2048, hop_length=HOP, fill_na=np.nan,
    )
    return f0.astype(np.float64), "pyin"


def _frame_rms(y: np.ndarray, win: int = 1024, hop: int = HOP) -> np.ndarray:
    if len(y) < win:
        return np.array([float(np.sqrt(np.mean(y ** 2)))])
    n = (len(y) - win) // hop + 1
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    return np.sqrt((y[idx] ** 2).mean(axis=1))


def _gate_silence(f0: np.ndarray, y: np.ndarray) -> np.ndarray:
    """静音段的音高一律作废。

    CREPE 在很轻的残留声上也照样输出 pitch（实测《盲选》203~204.6s 能量只有
    0.005，仍然被判成一个长音），必须在能量层面再拦一道。
    阈值取"整轨 75 分位能量的 8%"，下限 0.006 —— 既能盖住静音，又不会误伤轻声演唱。
    """
    r = _frame_rms(y)
    m = min(len(f0), len(r))
    if m <= 0:
        return f0
    hi = float(np.nanpercentile(r, 75))
    gate = max(0.006, 0.08 * hi)
    out = f0.copy()
    head = out[:m]
    head[r[:m] < gate] = np.nan
    return out


def _detect_f0(y: np.ndarray) -> tuple[np.ndarray, str]:
    try:
        f0, method = _f0_crepe(y)
    except Exception as e:
        print(f"[Melody] CREPE 不可用，退 pyin: {e}")
        f0, method = _f0_pyin(y)
    return _gate_silence(f0, y), method


# ── 曲线 → 音符 ───────────────────────────────────────────────────

def _segment(f0: np.ndarray) -> list[dict]:
    """把逐帧 f0 合并成音符。半音量化 + 同音粘连 + 短线过滤。"""
    n = len(f0)
    if n == 0:
        return []
    midi = np.full(n, np.nan)
    v = np.isfinite(f0) & (f0 > FMIN) & (f0 < FMAX)
    midi[v] = 69.0 + 12.0 * np.log2(f0[v] / 440.0)

    # 量化到最近半音；NaN 保持
    q = np.where(np.isnan(midi), np.nan, np.round(midi))

    raw: list[list] = []          # [起始帧, 结束帧, 量化midi]
    i = 0
    while i < n:
        if np.isnan(q[i]):
            i += 1
            continue
        j = i
        while j + 1 < n and not np.isnan(q[j + 1]) and abs(q[j + 1] - q[i]) <= 0.5:
            j += 1
        raw.append([i, j, int(q[i])])
        i = j + 1

    # 同音高 + 间隔很短的合并（气口/换气不该把一句话切碎）
    merged: list[list] = []
    for a, b, m in raw:
        if merged and merged[-1][2] == m and (a - merged[-1][1] - 1) * HOP_S <= GAP_MERGE:
            merged[-1][1] = b
        else:
            merged.append([a, b, m])

    notes: list[dict] = []
    for a, b, m in merged:
        dur = (b - a + 1) * HOP_S
        if dur < MIN_NOTE:
            continue
        cents = float(np.nanmedian((midi[a:b + 1] - m)) * 100) if b >= a else 0.0
        notes.append({
            "t": round(a * HOP_S, 3),
            "d": round(dur, 3),
            "midi": m,
            "note": _lb().midi_to_note(m, octave=True, unicode=False),
            "cents": round(cents, 1),
        })
    return _drop_octave_outliers(notes)


def _drop_octave_outliers(notes: list[dict]) -> list[dict]:
    """清掉明显的八度/倍频误判：短音 + 与周围 1 秒内中位音高差 ≥10 个半音。"""
    if len(notes) < 3:
        return notes
    kept = []
    for i, n in enumerate(notes):
        near = [m["midi"] for j, m in enumerate(notes)
                if j != i and abs(m["t"] - n["t"]) <= 1.0]
        if n["d"] < 0.22 and len(near) >= 2:
            med = float(np.median(near))
            if abs(n["midi"] - med) >= 10:
                continue
        kept.append(n)
    return kept


def _by_lines(notes: list[dict], lines: list[dict], duration: float) -> list[dict]:
    """按 LRC 逐行切分。行尾取下一行起始，最后一行补到歌曲结束。"""
    out = []
    for k, ln in enumerate(lines):
        start = float(ln["time"])
        end = float(lines[k + 1]["time"]) if k + 1 < len(lines) else max(duration, start + 8)
        sel = [x for x in notes if start - 0.05 <= x["t"] < end]
        out.append({
            "t": round(start, 3),
            "end": round(end, 3),
            "text": ln["text"],
            "notes": sel,
        })
    return out


# ── 缓存 / 路径 ───────────────────────────────────────────────────

def cache_dir() -> Path:
    return scanner.MUSIC_DIR / DIR_NAME


def _safe_stem(name: str) -> str:
    import re
    s = re.sub(r'[\\/:*?"<>|]', "_", name or "").strip().rstrip(".")
    return (s or "untitled")[:90]


def _cache_path(filepath: str, title: str) -> Path:
    base = _safe_stem(Path(filepath).stem if filepath else title)
    return cache_dir() / f"{base}.json"


# ── 对外 ─────────────────────────────────────────────────────────

def get(song_id: str, filepath: str, title: str,
        lrc_path: str | None, force: bool = False) -> dict:
    """返回旋律数据。status: ok / no_vocals / separator_unavailable / error"""
    vocals = stems_mod.stems_path(song_id, "vocals")
    has_vocals = vocals and Path(vocals).exists()

    if not force:
        p = _cache_path(filepath, title)
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if data.get("engine") != ENGINE:
                    return _analyze(song_id, filepath, title, lrc_path, has_vocals)
                data["cached"] = True
                data["has_vocals"] = has_vocals
                return data
            except Exception:
                pass

    if not has_vocals:
        return {
            "status": "no_vocals", "cached": False, "has_vocals": False,
            "message": "这首歌还没有分离过人声，旋律需要人声轨才能算准",
        }

    with _analyze_sem:
        # 排队期间别人可能已经算完落盘了，再查一次，避免重复分析
        if not force:
            p = _cache_path(filepath, title)
            if p.exists():
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    if data.get("engine") == ENGINE:
                        data["cached"] = True
                        data["has_vocals"] = True
                        return data
                except Exception:
                    pass
        return _analyze(song_id, filepath, title, lrc_path, has_vocals)


def _analyze(song_id: str, filepath: str, title: str,
             lrc_path: str | None, has_vocals: bool) -> dict:
    vocals = stems_mod.stems_path(song_id, "vocals")
    t0 = time.time()
    try:
        y, _ = _lb().load(str(vocals), sr=SR, mono=True)
        f0, method = _detect_f0(y)
        notes = _segment(f0)
        duration = len(y) / SR

        lines: list[dict] = []
        if lrc_path and Path(lrc_path).exists():
            from lyrics import parse_lrc
            try:
                parsed = parse_lrc(lrc_path)
                lines = [{"time": l.time, "text": l.text} for l in parsed.lines]
            except Exception as e:
                print(f"[Melody] 歌词解析失败: {e}")

        data = {
            "status": "ok",
            "engine": ENGINE,
            "method": method,
            "duration": round(duration, 2),
            "fps": round(1 / HOP_S, 1),
            "notes": notes,
            "lines": _by_lines(notes, lines, duration),
            "took_ms": int((time.time() - t0) * 1000),
            "cached": False,
            "has_vocals": True,
        }
        try:
            cache_dir().mkdir(parents=True, exist_ok=True)
            _cache_path(filepath, title).write_text(
                json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        except Exception as e:
            print(f"[Melody] 写盘失败: {e}")
        print(f"[Melody] {title}: {len(notes)} 个音符, {method}, "
              f"{data['took_ms']}ms")
        return data
    except Exception as e:
        print(f"[Melody] 分析失败 {title}: {e}")
        return {"status": "error", "message": str(e), "cached": False,
                "has_vocals": True, "notes": [], "lines": []}


def clear_cache() -> None:
    with _lock:
        _jobs.clear()
