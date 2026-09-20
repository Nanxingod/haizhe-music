# 海蜇音乐播放器 · 代码细节指南（DEV_GUIDE）

> 面向"要改代码"的人。README 讲清楚"这是什么、怎么跑起来"，本文讲清楚"每个文件负责什么、为什么这么写、改哪里会踩坑"。
>
> **对应版本**：V12.7（当前 HEAD，含音效引擎 / 人声分离 / 背景 DIY / 桌面体验修复）

---

## 目录

| 章节 | 内容 |
|------|------|
| [0. 阅读指南](#0-阅读指南) | 代码规模、阅读顺序、命名约定 |
| [1. 整体架构与启动链路](#1-整体架构与启动链路) | 三进程模型、端口、一次启动发生了什么 |
| [2. 后端 FastAPI](#2-后端-fastapi) | main / scanner / lyrics / models / separator / setup_stem_models |
| [3. 音效引擎 fx.ts](#3-音效引擎-fxts) | 两层架构、音质保护四条铁律 |
| [4. 前端状态机 store.tsx](#4-前端状态机-storetsx) | reducer、副作用、切歌时序、四道防线 |
| [5. 前端组件与页面](#5-前端组件与页面) | 组件树、FxPanel、背景与字体系统 |
| [6. Electron 桌面壳](#6-electron-桌面壳) | 单实例、端口清场、进程树清理、桌面歌词窗 |
| [7. 关键流程时序图](#7-关键流程时序图) | 播放 / 切歌 / 分离 / 换曲库 |
| [8. 设计决策与踩坑记录](#8-设计决策与踩坑记录) | V8 → V12.7 逐个版本的根因与修复 |
| [9. 调试与自检清单](#9-调试与自检清单) | 常用断点、自检钩子、常见故障排查 |

---

## 0. 阅读指南

### 代码规模（不含 node_modules / release）

```
backend/     4 个 .py  + 1 个模型部署脚本        ≈ 45 KB
frontend/   17 个 .ts/.tsx + 1 个 index.css      ≈ 140 KB
electron/    1 个 main.js + preload + lyrics.html ≈ 15 KB
```

源码本身很小，真正大的是 `node_modules/`（~650MB）和 `release/`（打包产物 ~360MB），以及 `backend/vendor/`（人声分离依赖，按需安装，~3GB）。

### 推荐阅读顺序

```
1) backend/main.py        ← 看接口总览，建立"后端能干什么"的地图
2) frontend/src/store.tsx ← 看状态机，这是整个前端的心脏
3) frontend/src/fx.ts     ← 音效引擎，V12 新增，独立且自洽
4) backend/separator.py   ← 人声分离，第二个相对独立的子系统
5) 其余组件按需翻阅
```

### 命名约定

| 前缀/后缀 | 含义 | 例子 |
|-----------|------|------|
| `_xxx`（模块级函数） | 模块内部实现，不对外 | `scanner._split_artists()` |
| `xxxRef` | `useRef`，用于绕开 React 渲染链路读实时值 | `timeRef`、`fxParamsRef` |
| `handleXxx` | 事件回调 | `handleTimeUpdate` |
| `haizhe-xxx` | localStorage 键名前缀 | `haizhe-fx`、`haizhe-bg` |
| `Stem` / `stems` | 人声分离出的音轨（人声 / 伴奏） | `Stem = 'original' \| 'vocals' \| 'instrumental'` |
| `Fx` | 音效（倍速 / 升降 KEY / 小黄人） | `FxEngine`、`FxPanel` |

---

## 1. 整体架构与启动链路

### 1.1 三进程模型

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程 (electron/main.js)                            │
│   ├─ 单实例锁 + 端口清场                                       │
│   ├─ spawn → Python 后端   (backend/main.py, :8765)          │
│   ├─ spawn → Vite 前端     (frontend, :5173)                 │
│   ├─ BrowserWindow  → 加载 http://localhost:5173              │
│   └─ BrowserWindow  → 加载 electron/lyrics.html（桌面歌词窗）  │
└─────────────────────────────────────────────────────────────┘
                              │
        前端 /api/* 请求经 Vite proxy 转发到 :8765
```

关键点：**前端永远用相对路径 `/api/...`**（见 `frontend/src/api.ts` 的 `const BASE = ''`），由 Vite 的 proxy 转发。这样打包成 Electron 后即使端口变化也不用改代码。

> ⚠️ 已知遗留问题：`electron-builder` 打包版因为 `file://` 协议下 `/api` 全部失效，目前只有开发模式（双击快捷方式走 Vite dev server）可用。源码里已备好 `backend/haizhe-backend.spec`（PyInstaller），但打包链路尚未打通。

### 1.2 端口与目录

| 项 | 值 | 配置位置 |
|----|-----|----------|
| 后端端口 | 8765 | `backend/main.py` 末尾 `uvicorn.run(..., port=8765)` |
| 前端端口 | 5173 | Vite 默认，`vite.config.ts` 里配 proxy |
| 音乐目录 | 运行时可切换 | `backend/config.json` 的 `music_dir` |
| 封面缓存 | `backend/cache/covers/` | `scanner.COVER_CACHE_DIR` |
| 分离模型 | `backend/cache/stem_models/` | `separator.MODEL_DIR` |
| 分离结果 | `<音乐目录>/人声分离/` | `separator.stems_dir()`（动态函数） |

### 1.3 启动时序（桌面版）

```
start-desktop.vbs （纯 ASCII，无窗口）
  └─ wscript 启动 electron
       └─ electron/main.js
            ├─ app.requestSingleInstanceLock()  失败则聚焦已有窗口并退出
            ├─ killPortOccupants()              清掉 8765/5173 上的残留进程
            ├─ spawn python main.py             后端启动 → scan_all() 全量扫描
            ├─ spawn vite --host 0.0.0.0        前端 dev server
            ├─ 轮询等两个端口就绪
            └─ new BrowserWindow → loadURL('http://localhost:5173')
```

后端冷启动扫描 676 首歌约 7–14 秒，期间 Electron 会显示加载窗口。**扫描期间流媒体接口照常可用**（`set_config` 用同步 `def`，FastAPI 自动丢线程池，见 §2.1）。

---

## 2. 后端 FastAPI

### 2.1 `backend/main.py`（413 行）—— 服务入口与全部 HTTP 接口

**模块级状态**

```python
ALL_SONGS: list[Song] = []
ARTISTS: list[Artist] = []
```

两个全局变量就是整个后端的数据源。没有数据库——每次启动重新扫描，扫描结果常驻内存。这是"个人曲库"场景下的最优解：676 首歌的内存占用可忽略，换来的是零运维。

**中间件**

```python
app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)   # 手机同 WiFi 访问
app.add_middleware(GZipMiddleware, minimum_size=500)           # 列表 JSON 压缩
```

**接口总览**

| 方法 | 路径 | 作用 | 备注 |
|------|------|------|------|
| GET | `/api/status` | 歌曲数 / 歌手数 / 当前音乐目录 / 缓存封面数 | 设置页展示 |
| GET | `/api/artists` | 歌手列表（含 `song_count`、封面代表歌曲） | |
| GET | `/api/artists/{name}` | 某歌手的歌 | |
| GET | `/api/songs?search=&limit=&offset=` | 歌曲列表 / 搜索 | 分页 |
| GET | `/api/songs/{id}` | 单曲详情 | |
| GET | `/api/stream/{id}?stem=` | **流媒体**（核心） | `stem=vocals\|instrumental` 播分离音轨 |
| GET | `/api/cover/{id}?size=` | 封面（150 缩略 / 800 原图） | |
| GET | `/api/lyrics/{id}` | LRC 歌词 | |
| GET/POST | `/api/config` | 读写音乐目录（**运行时切换曲库**） | |
| GET | `/api/bg-images/{area}` | 列出某区域背景图 | `main\|sidebar\|player` |
| POST | `/api/bg-images/{area}?name=` | 上传背景图 | |
| GET | `/api/bg-image/{area}/{file}` | 读取背景图 | |
| DELETE | `/api/bg-images/{area}/{file}` | 删除背景图 | |
| GET | `/api/stems` | 分离能力探测 + 已缓存列表 | |
| GET | `/api/stems/{id}` | 单曲分离状态（含进度） | 前端 2s 轮询 |
| POST | `/api/stems/{id}/separate?quality=` | 启动分离 | |
| DELETE | `/api/stems/{id}` | 删除分离结果 | |
| POST | `/api/refresh` | 重新扫描曲库 | |

**流媒体实现（Range 请求）**

```python
STREAM_BUF = 128 * 1024   # 128KB 块

@app.get("/api/stream/{song_id}")
async def stream_audio(song_id, request, stem: str = Query(default="")):
    if stem in ("vocals", "instrumental"):
        f = stems_mod.stems_path(song_id, stem)          # FLAC
        filepath, mime = str(f), "audio/flac"
    else:
        filepath, mime = song.file_path, "audio/mpeg"    # MP3
    ...
```

- 无 `Range` 头 → `FileResponse` 全量返回（首帧）
- 有 `Range` 头 → 解析 `bytes=start-end` → `f.seek(start)` → 生成器按 128KB 分块 yield → `206 Partial Content`
- 10MB 的歌从 ~1280 次 `read()` 降到 ~80 次，拖拽进度条时浏览器会自动发多次 Range 请求

> **V10.3 修复**：`file_iterator` 曾经没有 try/except。磁盘 I/O 异常（杀软拦截、文件被锁）会让生成器静默中断，浏览器只看到"响应被截断"而不触发 `error` 事件 → 播放器卡死无声。现在捕获后打日志。

**`/api/config` 为什么用同步 `def`**

```python
@app.post("/api/config")
def set_config(body: dict):     # ← 注意没有 async
```

FastAPI 对同步 `def` 的处理是丢进线程池执行。切曲库需要全量重扫（7–14s），如果写成 `async def` 会阻塞事件循环，导致这段时间所有流媒体请求卡死。写成同步函数后，扫描在线程池里跑，播放器照常出声。

**启动钩子有两个**

```python
@app.on_event("startup")
async def startup():            # 扫描 + 分离目录迁移
@app.on_event("startup")
async def setup_gc_timer():     # 5 分钟一次 gc + 后台预检 GPU
```

GPU 预检放后台线程是因为 `import torch` 要 1–2 秒，如果放在首次打开效果面板时同步执行，会明显卡顿。

**uvicorn 参数（V10.2 教训）**

```python
uvicorn.run(app, host="0.0.0.0", port=8765, log_level="warning",
            timeout_keep_alive=30, limit_concurrency=50)
# 注意：这里【没有】 limit_max_requests
```

`limit_max_requests=5000` 曾经导致 worker 跑到 5000 请求后自动重启，所有正在播放的流瞬间断开 → 前端错误处理触发无限切歌的"死亡螺旋"。个人播放器不需要 worker 回收。

---

### 2.2 `backend/scanner.py`（280 行）—— 扫描、元数据、封面缓存

**音乐目录是动态的**

```python
def _load_music_dir() -> Path:
    config_path = Path(__file__).parent / "config.json"
    default = Path.home() / "Music"          # ← 跨平台默认值，不要写死某个盘符
    try:
        if config_path.exists():
            cfg = json.load(open(config_path, "r", encoding="utf-8"))
            d = cfg.get("music_dir", "")
            ...
MUSIC_DIR = _load_music_dir()

def set_music_dir(new_dir: str) -> tuple[bool, str]:
    """校验 → 写 config.json → 返回 (ok, msg)"""
```

`MUSIC_DIR` 是模块级变量，运行时可改。所以**任何需要音乐目录的地方都必须调用函数而不是缓存路径**——这就是 `separator.stems_dir()` 写成函数的原因（`scanner.MUSIC_DIR / "人声分离"`）。

**扫描缓存**

```python
def _load_scan_cache() -> dict:      # backend/cache/scan_cache.json
def _save_scan_cache(files: dict):
```

记录每个文件的 mtime + 已解析元数据。二次启动时只解析变化过的文件，冷启动 7–14s → 热启动 1–2s。

**多歌手拆分**

```python
ARTIST_SPLIT_RE = re.compile(r"[、,，/&]|\bfeat\.?\b", re.IGNORECASE)

"徐良、阿悄"        → ["徐良", "阿悄"]
"汪苏泷 / BY2"      → ["汪苏泷", "BY2"]
"周杰伦 feat. 蔡依林" → ["周杰伦", "蔡依林"]
```

拆分后一首歌会同时出现在所有合作歌手的页面里，但歌手总数不重复计数。

**封面预提取（V9 的关键优化）**

```python
def _extract_and_cache_cover(filepath, song_id) -> bool:
    # mutagen.ID3 读 APIC 帧 → Pillow 缩放 150×150 → JPEG 存 cache/covers/{song_id}.jpg
```

启动时一次性把 676 张 1000×1000 原图压成 150px 缩略图落盘。列表页请求 `/api/cover/{id}?size=150` 直接 `FileResponse` 读磁盘（<5ms）；全屏才按需提取原图。

> 背景：V8 时代列表直接加载原图，Chromium 把它们全量解码进 GPU，内存飙到 2.7GB。

**其他函数**

| 函数 | 作用 |
|------|------|
| `_parse_filename()` | 从文件名兜底解析 `歌手 - 歌名`（ID3 缺失时） |
| `_file_id()` | 用文件路径生成稳定 song_id |
| `_get_duration()` | mutagen 读时长 |
| `scan_all()` | 主入口，返回 `(songs, artists)` |
| `get_songs_by_artist()` / `search_songs()` | 查询 |

---

### 2.3 `backend/lyrics.py` / `backend/models.py`

- `lyrics.py`（1.5KB）：`parse_lrc(path)` → `Lyrics`，含 `lines[{time, text}]` 和 `ti/ar/al` 三个元数据标签。时间格式 `[mm:ss.xx]`。
- `models.py`（762B）：Pydantic 模型 `Song` / `Artist`，字段与 `frontend/src/types.ts` 保持一致。

> 改任一侧都要同步另一侧，这是全项目唯一的"隐式契约"。

---

### 2.4 `backend/separator.py`（348 行）—— 人声/伴奏分离

这是 V12 新增的第二个相对独立的子系统，依赖可选（装了才有）。

**依赖装在 `backend/vendor/`**

```python
_VENDOR = Path(__file__).parent / "vendor"
if _VENDOR.exists() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))
```

用 `pip install --target vendor` 装，不污染系统 Python 环境。没装时 `is_available()` 返回 `False`，前端效果面板只是显示提示，不影响正常播放。

**两档质量**

```python
MODELS = {
    "standard": "MDX23C-8KFFT-InstVoc_HQ.ckpt",   # MDX23C 2023，CPU 5–15 分钟/首
    "hq":       "model_bs_polarformer_float16.ckpt",  # BS PolarFormer 2025，GPU ~30s
}
```

`_mode(quality)` 把档位映射成目录后缀：`standard → C`，`hq → G`。

**输出目录命名（V12.7 改过）**

```
<音乐目录>/人声分离/<原歌曲文件名>_C/     ← 标准档
                  ├── vocals.flac
                  ├── instrumental.flac
                  └── meta.json          {song_id, filepath, quality, gpu}
```

用"原文件名"而不是 song_id 命名，是为了让人在文件管理器里一眼认出是哪首歌。代价是**无法从目录名反推 song_id**，所以：

```python
_song_dirs: dict[str, Path] = {}     # song_id → 目录

def _rebuild_index():
    """扫 stems_dir，读每个目录的 meta.json 建索引"""
```

索引在首次访问或切换音乐目录后重建（切换目录会把 `_index_built` 置回 False）。

**为什么结果放在音乐目录里而不是 backend/cache**

放在 `<音乐目录>/人声分离/` 与曲库同处：换机、备份曲库时分离结果跟着走，不会白算一遍。代价是这个目录会被扫描器看到——不过 `scan_all()` 只扫顶层 `*.mp3`，子目录不会被误认成歌曲。

**任务状态机**

```python
_tasks: dict[str, dict] = {}    # song_id -> {status, progress, error, quality}
# status: none → processing(2→5→8→15→90) → ready(100) | error
```

`start_separation()` 校验后起一个 daemon 线程跑 `_run()`，主线程立刻返回，前端靠轮询 `/api/stems/{id}` 看进度。`is_busy()` 保证同一时刻只有一个分离任务（GPU 显存有限）。

**幂等判断**

```python
existing = _song_dir(song_id)
if existing and cached_quality(song_id) == quality:
    return None      # 已有同质量缓存，不重复算
```

脏检查靠 `meta.json` 里的 `quality` 字段；老缓存（没有 quality 字段）一律视为 `standard`。

**两处迁移逻辑**

1. 模块顶部：`backend/cache/stems/` （V12 早期位置）→ 新位置
2. `migrate_legacy(song_files)`：老式"目录名 = song_id" → "原文件名_C/G"，由 `main.py` 启动时调用，改名后补写 `song_id/filepath` 到 meta

改目录命名这块有过一次返工，所以留下了两套迁移代码。新增第三种命名方式前请先想清楚要不要再加一套迁移。

**ffmpeg 兜底**

```python
def _ensure_ffmpeg() -> bool:
    if shutil.which("ffmpeg"): return True
    # 否则用 imageio-ffmpeg 自带的二进制，复制/硬链接成 ffmpeg.exe 并加进 PATH
```

`audio-separator` 强依赖 ffmpeg。系统没装时靠 Python 包自带的那份顶上。

---

### 2.5 `backend/setup_stem_models.py`（~19KB）—— 高质量模型一键部署

高质量档用的 **BS PolarFormer** 有两个麻烦，这个脚本一次性解决：

1. **权重不在 audio-separator 的官方模型注册表里** → 手动从 GitHub release 下载（102MB float16）
2. **模型用了 PoPE 位置编码，原库不认识** → 需要给 `vendor` 里的库打补丁

**做了四件事**

| 函数 | 作用 |
|------|------|
| `download(url, dst, expected_sha256)` | 带 sha256 校验下载模型 + yaml |
| `patch_bs_roformer()` | 注入 `PoPE` 类（移植自 lucidrains/PoPE-pytorch，MIT，纯 PyTorch 无新依赖，兼容 Python 3.9） |
| `patch_separator()` | 让 `audio_separator.Separator` 能加载带 PoPE 权重键的模型 |
| `fix_yaml()` | 生成修正版 yaml，对齐推理所需的 `hop_length` / `inference` / stem 命名 |

**幂等**：打过补丁会在 `vendor` 里写标记文件，重复运行直接跳过。

> PoPE（Polar Coordinate Positional Embeddings，arXiv:2509.10534）与 RoPE 的差别：每层每个 Attention 一个独立 PoPE 模块（含可学习 bias），权重键是 `pope_embed.{bias, inv_freqs}`，且 q/k 的幅度先过 softplus 再旋转。原版 `PoPE-pytorch` 包要求 Python ≥ 3.10，所以这里是内嵌实现。

---

### 2.6 `backend/haizhe-backend.spec`

PyInstaller 打包配置，把后端编成独立 `haizhe-backend.exe`（目标：完全免 Python 的分发包）。目前 spec 已备好，但整条打包链路（配合 electron-builder）还没打通——**这是当前最大的未完成项**。

---

## 3. 音效引擎 `frontend/src/fx.ts`

V12 的核心新增。157 行，自洽且无外部状态，可以独立理解。

### 3.1 为什么分两层

浏览器改音频有两套机制，代价完全不同：

| 能力 | 实现 | 代价 |
|------|------|------|
| 倍速 0.5–2x | `audio.playbackRate` | **零**（浏览器原生，不改采样） |
| 小黄人变声 | `audio.preservesPitch = false` | **零**（关掉音高保持即可） |
| 升降 KEY ±12 | 必须过 WebAudio 图做变调 | 有——会改变音频走向 |

所以设计成：

```
第 1 层  原生属性层          playbackRate / preservesPitch
         └─ 无需用户手势，随时生效，音质无损

第 2 层  WebAudio 层         MediaElementSource → SignalsmithStretch(AudioWorklet) → destination
         └─ 仅当 semitones ≠ 0 时启用
```

### 3.2 四条音质保护铁律

`createMediaElementSource` 是**不可逆**的——一旦调用，这个 `<audio>` 元素的输出就永久改道进 AudioContext，再也不会走浏览器原生路径。原曲如果也流经变调处理器，即使处理器设为"不处理"，也会有一次浮点往返（还可能因为算法的 STFT 窗口引入细微染色）。

所以代码里处处是防御：

```typescript
// 铁律 1：移调 ≠ 0 才建管线
if (p.semitones !== 0) {
    ...
    this.ensureGraph().then(ok => { ... });
} else if (this.ctx && !this.bypass) {
    // 铁律 2：移调归零 → 立刻切回直通
    this.bypass = true;
    this.route();
}
```

```typescript
// 铁律 3：非手势上下文不建图
const activated = (navigator as any).userActivation?.isActive;
if (!this.ctx && !activated) return;
```

suspended 状态的 AudioContext 会把音频"吞掉"导致静音。浏览器自动播放策略要求用户手势后才允许 `resume()`。如果重启时从 localStorage 恢复了上次的移调值，此时直接建图就会静音——所以先跳过，等 `store.tsx` 的手势监听器补建（`gestureApply()`）。

```typescript
// 铁律 4：切歌时冲掉 Stretch 内部残留
clear() {
    if (this.ctx && !this.bypass) { this.bypass = true; this.route(); }
}
```

STFT 类算法内部有重叠缓冲区，换音源不清会有几十毫秒的旧音频尾巴漏出来。

### 3.3 直通是怎么做到"位透明"的

```typescript
private route() {
    this.srcNode.disconnect();
    if (this.bypass || !this.stretch) {
        this.srcNode.connect(this.ctx.destination);   // 直连
    } else {
        this.srcNode.connect(this.stretch);           // 过处理器
    }
}
```

注意：**直通不是"绕过 AudioContext"，而是绕过 Stretch 节点**。管线一旦建了就拆不掉，但让信号 `src → destination` 直连，WebAudio 内部是纯浮点拷贝，位透明无损。

### 3.4 一个容易漏的细节：`defaultPlaybackRate`

```typescript
a.defaultPlaybackRate = p.rate;
a.playbackRate = p.rate;
```

`audio.src` 变更会触发 load 算法，把 `playbackRate` 重置回 `defaultPlaybackRate`。只设 `playbackRate` 的话，切歌/切音轨后倍速会静默掉回 1x。两个一起设才能保住。

### 3.5 引擎升级（V12.2）

V12.1 用的是 SoundTouch（`ScriptProcessorNode`，跑在主线程）——主线程一卡（比如渲染 676 行列表）音频就爆音。V12.2 换成 **Signalsmith Stretch**（WASM + AudioWorklet，跑在音频线程），且谐波保真 + 瞬态处理明显优于 WSOLA 类算法。

```typescript
const stretch = await SignalsmithStretch(ctx);     // WASM 异步加载
stretch.connect(ctx.destination);
...
this.stretch.schedule({ semitones, active: true });  // active:true 必须显式传
```

> `active: false` 时输出是**静音**而不是直通——这是个坑，别用它当 bypass。

`graphPromise` 用于防重入：滑动移调滑块会高频触发 `apply()`，WASM 加载只能有一次。

---

## 4. 前端状态机 `frontend/src/store.tsx`

609 行，`useReducer + Context`。全项目唯一的状态源。

### 4.1 State 形状

```typescript
{
  currentSong, playlist, isPlaying, currentTime, duration,
  volume, isMuted, playMode, lastSongId,
  // V12 新增
  playbackRate, pitchSemitones, chipmunk,
  stem: 'original' | 'vocals' | 'instrumental',
  playToken: number,
}
```

### 4.2 V12 新增的四个 Action

```typescript
| { type: 'SET_RATE';      rate: number }        // clamp 0.5~2
| { type: 'SET_PITCH';     semitones: number }   // clamp -12~+12
| { type: 'TOGGLE_CHIPMUNK' }
| { type: 'SET_STEM';      stem: Stem }
```

**`playToken` 是干嘛的**：单曲循环模式下播完绕回同一首歌，`currentSong.id` 和 `stem` 都没变，驱动 src 重载的 effect 不会触发。所以每次"重播"都 `playToken + 1`，把它塞进依赖数组强制重新加载。

### 4.3 音效持久化

```typescript
localStorage 'haizhe-fx' → { rate, semitones, chipmunk }
```

**`stem` 不持久化**——重启一律回原唱。因为分离音轨是 FLAC 大文件，重启就自动切到伴奏会很意外。

读取时有范围校验（`loadFxState()`），防止手改 localStorage 把值设成 NaN。

### 4.4 三个与音效相关的 effect

```typescript
// ① 手势监听：绑定 + 唤醒 + 补建管线
useEffect(() => {
  const onGesture = () => { fx.bind(...); fx.resume(); fx.gestureApply(); };
  window.addEventListener('pointerdown', onGesture, { capture: true });
  window.addEventListener('keydown', onGesture, { capture: true });
}, []);

// ② 参数变化 → 应用 + 持久化
useEffect(() => { fx.apply({rate, semitones, chipmunk}); localStorage.setItem(...) },
          [state.playbackRate, state.pitchSemitones, state.chipmunk]);

// ③ 开发期自检钩子
useEffect(() => { if (import.meta.env.DEV) (window as any).__fxEngine = fxEngineRef.current; }, []);
```

注意 ① 用 `capture: true`：任何点击/按键都能捕获，包括被 `stopPropagation` 拦掉的事件。

### 4.5 切歌/切音轨时序（最复杂的一段）

```typescript
useEffect(() => {
  const songChanged = prevSongIdRef.current !== songId;
  const keepTime = !songChanged && !audio.ended && audio.currentTime > 0.3;
  const resumeAt = keepTime ? audio.currentTime : 0;

  audio.pause();
  audio.src = '';                              // ① 释放旧解码缓冲
  audio.src = api.streamUrl(songId, state.stem); // ② 换源
  fxEngineRef.current!.clear();                 // ③ 冲掉 Stretch 残留

  const onMeta = () => {
    fxEngineRef.current!.apply(fxParamsRef.current);   // ④ src 重载重置了 rate，补回来
    if (keepTime) audio.currentTime = Math.min(resumeAt, audio.duration - 0.5);
    if (wasPlaying) {
      audio.play().catch(() => {                // ⑤ play 失败等 canplay 重试
        audio.addEventListener('canplay', () => audio.play().catch(()=>{}), { once: true });
      });
    }
  };
  audio.addEventListener('loadedmetadata', onMeta);
}, [state.currentSong?.id, state.stem, state.playToken]);
```

几个容易改坏的点：

- **`keepTime` 的 `!audio.ended`**：自然播完绕回同一首歌时不能"保留进度"，否则永远卡在结尾。
- **`fxParamsRef`**：effect 依赖里没有音效参数（否则改个移调就会重新加载音频），但 `src` 重载会重置 `playbackRate`，所以要用 ref 拿最新值在 `loadedmetadata` 里补应用。
- **`audio.src = ''`**：Chromium 规范中明确触发媒体资源释放的标准写法。`removeAttribute('src')` 只删 HTML 属性，JS 属性仍指向旧 URL，缓冲不释放——这是 V9 时代"听 50 首歌涨 500MB"的根因。

### 4.6 四道防线（V10.2 / V10.3）

| 防线 | 触发 | 行为 |
|------|------|------|
| 连续跳歌上限 | `error` 事件 | `MAX_CONSECUTIVE_SKIPS = 3`，超过就停止自动跳歌并告警 |
| 冷却 | 每次跳歌 | 2 秒，防止瞬间刷屏 |
| stalled 检测 | `stalled` 事件 | 给 10 秒恢复时间，超时才跳 |
| waiting 检测 | `waiting` 事件 | 15 秒超时（补 stalled 没覆盖的网络抖动场景） |

这套防线是为了防止"后端异常 → 前端无限切歌"的死亡螺旋。这个螺旋的真实触发过一次：uvicorn 的 `limit_max_requests` 让 worker 重启，所有流断开，前端每秒跳一首。

---

## 5. 前端组件与页面

### 5.1 组件树

```
main.tsx
 └─ App.tsx
     ├─ BrowserRouter
     ├─ PlayerProvider (store.tsx)
     ├─ BackgroundInit          ← V12.5：启动时注入背景 CSS
     ├─ TitleBar                ← Electron 自定义标题栏
     ├─ Sidebar                 ← 导航 + .sidebar-bg 背景层
     ├─ <Routes>
     │   ├─ /            AllSongsPage
     │   ├─ /artists     ArtistsPage
     │   ├─ /artist/:name ArtistSongsPage
     │   ├─ /search      SearchPage
     │   └─ /settings    SettingsPage
     └─ PlayerBar
         ├─ FxPanel（点"效果"弹出）
         ├─ 全屏歌词面板
         └─ FloatingLyrics（PiP 悬浮窗）
```

### 5.2 `components/FxPanel.tsx`（251 行）

440px 宽的毛玻璃面板，四个功能区：倍速 / 升降 KEY / 小黄人 / 音轨。

```typescript
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
```

**定位**：`useLayoutEffect` 读锚点按钮的 `getBoundingClientRect()`，让面板水平中心对齐"效果"按钮中心，并 clamp 在视口内。`useLayoutEffect`（而非 `useEffect`）是为了避免先渲染在默认位置再跳一次。

**关闭**：`pointerdown` 监听，延迟 0ms 绑定——否则"打开面板的那次点击"会立刻把它关掉。

**分离状态轮询**：面板打开期间每 2 秒 `api.getStems(currentSong.id)`。首次拿到 GPU 状态时，如果有 GPU 就直接把质量默认选成 `hq`（又快又好）；用户手动选过之后（`qualityTouchedRef`）就不再自动改。

**UI 与状态的关系**：面板本身不持有音效状态，全部 `dispatch` 到 store，由 store 的 effect 应用到引擎。这样"从别处改了倍速"面板也会同步。

### 5.3 `components/PlayerBar.tsx`（~600 行）

最复杂的组件：底部播放栏 + 全屏歌词 + PiP + 效果按钮。

- `state.playbackRate !== 1 || pitchSemitones !== 0 || chipmunk || stem !== 'original'` → "效果"按钮高亮，提示当前有音效在生效
- 全屏封面的 cleanup：`coverRef.current.src = ''`，配合 `key` 强制卸载释放 Chromium 解码位图

### 5.4 背景与字体系统

**背景（`App.tsx` + `SettingsPage.tsx`）**

三个区域 `main / sidebar / player`，各自的图 + 调整参数：

```typescript
interface BgAdjust { dim: number; contrast?: number; blur?: number; }
```

V12.5 加了 **sidebar 跟随模式**（`sidebar: 'follow'`）：禁用侧边栏自己的图片层，让 `body::before` 的主背景直接透出。好处是同一张图同一个渲染结果，几何完全一致 = 绝对无缝。

> 不能用 `background-attachment: fixed` 复刻：主背景盒子有 -30px 扩边（blur 防露边），两边 cover 缩放基准不同会产生约 5% 的错位。

样式是**运行时注入 `<style>` 标签**（`applyBgStyle()`），不是 CSS 文件——因为图片 URL 是运行时才知道的。

localStorage：`haizhe-bg`（图）、`haizhe-dim`（调整参数，旧格式纯数字会自动 migrate 成对象）。

**字体（`SettingsPage.tsx`）**

8 款中文字体，三类独立配置（界面 / 标题 / 歌词），通过 CSS 变量 `--font-ui` / `--font-heading` / `--font-lyrics` 注入，立即生效。localStorage 键：`haizhe-font-{ui,heading,lyrics}`。

### 5.5 `pages/SettingsPage.tsx`（~25KB，最大的文件）

三块：音乐目录（`/api/config` + Electron 目录选择）、背景（上传/删除/调整）、字体；另有桌面歌词预览。

音乐目录切换走 `ea.pickMusicDir()`（Electron IPC 暴露的原生目录选择器），拿到路径后 `POST /api/config`，后端校验 + 重扫 + 返回新歌曲数。

---

## 6. Electron 桌面壳

### 6.1 `electron/main.js`（13KB）

**单实例锁**（V11）

```javascript
if (app.requestSingleInstanceLock()) return true;
```

重复启动时不新开窗口，聚焦已有窗口。V11.1 加了锁等待重试——旧实例退出期间清理进程需要时间，立刻再启动会拿不到锁。

**端口清场**（V11）

```javascript
function killPortOccupants() { /* netstat 找占用 → taskkill /f /t /pid */ }
```

只在拿到单实例锁之后执行。用 `taskkill /T` 杀整棵进程树——只杀 PID 会留下 python/vite 孤儿进程继续占着端口。

**进程清理**（V11 关键修正）

```javascript
execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
// 必须【同步】执行
```

`spawn(..., { shell: true })` 出来的是 cmd 壳进程，`proc.kill()` 只能杀壳不杀真正的 python/vite。而且必须同步——异步的 taskkill 会在主进程 `exit` 之后才执行，等于没执行。

**图标**：`icon: path.join(__dirname, 'icon.ico')` + `app.setAppUserModelId('com.haizhe.music')`。两个都要——少了后者任务栏会显示 Electron 官方图标。

### 6.2 `electron/start-desktop.vbs` 的两个历史坑

1. 曾经误用批处理语法 `%~dp0`——VBS 不展开这个，导致"无窗口启动"从未生效
2. VBS 里写 UTF-8 中文注释，wscript 按 GBK 解析会语法错乱（报 `缺少对象: 'fso'`）

**结论**：这个文件必须保持**纯 ASCII**。快捷方式指向 `wscript.exe start-desktop.vbs`。

### 6.3 桌面歌词窗（`lyrics.html`）

```
transparent: true   alwaysOnTop: true (screen-saver 级)
frame: false        skipTaskbar: true
```

IPC 链路：`React → ipcRenderer.send('lyric-update') → main.js → lyricWin.webContents.send('lyric-data') → lyrics.html 更新 DOM`。

配置同步：用户改设置 → localStorage → 主进程 500ms tick 比对缓存 → 仅变化时才发 `lyric-config` IPC。

> V10 修过一个 bug：IPC 消息在歌词窗口加载完成前到达会被丢弃 → 加 `lyricReady` 标志位 + 暂存 `pendingLyricCfg`。

---

## 7. 关键流程时序图

### 7.1 播放一首歌

```
点击歌曲
  → dispatch({type:'PLAY', song, playlist})
  → state.currentSong 变化
  → src effect 触发 [currentSong.id, stem, playToken]
      audio.pause() → src='' → src=/api/stream/{id}
      fx.clear()
  → 浏览器发 Range 请求 → 后端 206 + 128KB 分块
  → loadedmetadata
      fx.apply(fxParamsRef.current)   ← src 重载后补回倍速
      audio.play()
  → canplay → isPlaying = true
```

### 7.2 切换音轨（原唱 → 伴奏）

```
音效面板 点"伴奏"
  → 前置：stemStatus.status === 'ready'
  → dispatch({type:'SET_STEM', stem:'instrumental'})
  → src effect 触发（stem 变了），songChanged = false
      keepTime = true → 记住 currentTime
      audio.src = /api/stream/{id}?stem=instrumental   ← 后端返回 FLAC
  → loadedmetadata → currentTime = resumeAt（进度不丢）
```

### 7.3 人声分离

```
点"人声 / 伴奏分离"
  → POST /api/stems/{id}/separate?quality=hq
  → 后端校验：audio-separator 装了？模型档位合法？已有同质量缓存？有其它任务在跑？
  → start_separation()：确定目录 <原文件名>_G/，起 daemon 线程
  → 立即返回 {status:'processing'}
  → 前端 2s 轮询 GET /api/stems/{id} → 进度条
  → 线程内：load_model → separate → 归一化文件名 → 写 meta.json → 更新索引
  → status = 'ready'
  → 前端音轨按钮解锁
```

### 7.4 切换音乐目录

```
设置页 选目录 → POST /api/config {music_dir}
  → scanner.set_music_dir()：校验 → 写 config.json → 更新 MUSIC_DIR
  → scan_all() 全量重扫（线程池，不阻塞事件循环）
  → stems_mod.migrate_legacy()：老命名迁移 + 重建索引
  → 返回新歌曲数
  → 前端更新显示
```

---

## 8. 设计决策与踩坑记录

### 8.1 内存管理（V8–V10.1）

| 版本 | 症状 | 根因 | 修复 |
|------|------|------|------|
| V8–V9 | 听 1 小时 → 2GB+ | 676 张 1000×1000 封面全量解码进 GPU | 启动时预生成 150px 缩略图落盘 |
| V9 | 切歌内存持续上涨 | `removeAttribute('src')` 不释放解码缓冲 | `audio.src = ''` |
| V10 | 全屏"词"页缓慢泄漏 | 原图无释放机制 | `key={songId}` 强制卸载 + cleanup 中 `src=''` |
| V10 | 给 `<img>` 加 `key` 反而爆内存 | key 变化触发重新解码管线 | 改用 `ref` + cleanup 中 `src=''` |
| V10.1 | 676 行列表每 500ms 重渲染 | 1690 闭包/秒，GC 跟不上 | `SongListContent` memo 隔离 |

**稳定基线**：空闲 ~500MB，播放中 500–800MB，不再单边上涨。

### 8.2 播放稳定性（V10.2–V10.3）

| 版本 | 症状 | 根因 | 修复 |
|------|------|------|------|
| V10.2 | 长期使用偶发卡死 + 无限切歌 | uvicorn `limit_max_requests=5000` 让 worker 重启，流全断 → 前端 NEXT 循环 | 移除该参数 + 前端四道防线 |
| V10.3 | V10.2 修完仍有"突然没声音" | ① 切歌时 `play()` 盲调无恢复 ② `file_iterator` 无异常处理 ③ `waiting` 事件未处理 ④ repeat-one 的 ended 分支同样问题 | `play()` 失败等 canplay 重试；iterator 加 try/except；waiting 15s 超时；ended 防御 |

### 8.3 桌面体验（V11）

| 症状 | 根因 | 修复 |
|------|------|------|
| 双击快捷方式总弹终端，关终端 = 杀应用 | ① VBS 用 `%~dp0`（VBS 不展开）② VBS 含 UTF-8 中文注释，wscript 按 GBK 解析出错 | VBS 改纯 ASCII + 自取路径；快捷方式指向 `wscript.exe` |
| 任务栏显示 Electron 官方图标 | 缺 `setAppUserModelId` | 加 `icon` + `setAppUserModelId('com.haizhe.music')` |
| 退出后端口被占 | `shell:true` 的 `kill()` 只杀 cmd 壳 | `taskkill /T /F` 杀进程树，且同步执行 |

### 8.4 音效（V12）

| 版本 | 变化 |
|------|------|
| V12.0 | 引入 FxEngine：倍速 / 小黄人走原生属性，升降 KEY 走 WebAudio |
| V12.1 | 音质保护：不建图时位透明直通；面板 400px 居中对齐 |
| V12.2 | 变调处理器 SoundTouch → Signalsmith Stretch（WASM + AudioWorklet，音频线程） |
| V12.3 | `playToken` 解决单曲循环绕回同首歌不重载的问题 |
| V12.5 | 侧边栏背景"跟随主背景"模式 |
| V12.7 | 分离结果目录改为「原文件名_C/G」；高质量模型换 BS PolarFormer |

### 8.5 人声分离（V12）

- **结果存哪**：选了 `<音乐目录>/人声分离/`。理由是换机/备份曲库时跟着走；代价是要靠 `meta.json` 建 song_id 索引。
- **为什么同一时刻只跑一个任务**：GPU 显存有限，并发会 OOM。
- **为什么 hq 需要额外脚本**：模型不在官方注册表 + 用了原库不认识的 PoPE 编码。

---

## 9. 调试与自检清单

### 9.1 常用入口

```bash
# 网页版（PC + 手机）
start.bat                     # 后端 :8765 + 前端 :5173

# 桌面版（推荐，无终端窗口）
双击桌面快捷方式「HaiZhe Music」

# 桌面版调试（输出写入 desktop.log）
start-desktop.bat
```

### 9.2 音效自检钩子

开发模式（`npm run dev`）下，`store.tsx` 会把引擎实例挂到 window：

```javascript
__fxEngine.debug
// → { attached: bool, bypass: bool, engine: 'signalsmith-stretch'|'none',
//     audioBound: bool, params: {rate, semitones, chipmunk} }
```

**期望值**：
- 只听原曲（从未移调）：`attached: false, bypass: true, engine: 'none'` ← 完全不建管线
- 移调 +3 半音：`attached: true, bypass: false, engine: 'signalsmith-stretch'`
- 移调归零：`attached: true, bypass: true` ← 管线还在但走直通

### 9.3 常见故障排查

| 现象 | 排查顺序 |
|------|----------|
| 启动后 0 首歌 | ① `backend/config.json` 的 `music_dir` 对不对 ② 目录里有没有顶层 `.mp3` ③ 后端日志有无 `启动完成，N 首歌就绪` |
| 有歌无封面 | `backend/cache/covers/` 是否有对应 jpg；MP3 是否真有 APIC 帧 |
| 端口被占 | `netstat -ano \| findstr 8765` → 手动 taskkill，或重启 Electron（会自动清场） |
| 效果面板提示"需要安装 audio-separator" | `backend/vendor/` 是否存在；没有就 `pip install audio-separator --target backend/vendor` |
| 高质量分离失败 | 先跑 `python backend/setup_stem_models.py`；确认有 NVIDIA GPU + CUDA 版 torch |
| 打包版 `/api` 全挂 | 已知问题：`file://` 下相对路径失效，等 PyInstaller + electron-builder 链路打通 |

### 9.4 改代码前的检查清单

- [ ] 改了 `models.py` 的字段 → 同步 `frontend/src/types.ts`
- [ ] 新增了用到音乐目录的地方 → 用 `scanner.MUSIC_DIR` 或函数调用，**不要缓存路径**
- [ ] 动了 `audio.src` 相关逻辑 → 记得 `fx.apply()` 补回倍速（src 重载会重置 `playbackRate`）
- [ ] 动了音效引擎 → 确认没破坏"不建图就位透明"的原则
- [ ] 动了分离目录命名 → 想清楚要不要再加一套迁移代码
- [ ] 改了 `start-desktop.vbs` → **保持纯 ASCII**

---

## 附录：文件速查表

| 文件 | 行数 | 职责 |
|------|------|------|
| `backend/main.py` | 413 | FastAPI 服务、全部 HTTP 接口 |
| `backend/scanner.py` | 280 | 扫描 / ID3 / 封面缓存 / 多歌手拆分 |
| `backend/separator.py` | 348 | 人声分离任务与结果管理 |
| `backend/setup_stem_models.py` | ~500 | HQ 模型下载 + PoPE 补丁 |
| `backend/lyrics.py` | ~50 | LRC 解析 |
| `backend/models.py` | ~30 | Pydantic 模型 |
| `frontend/src/store.tsx` | 609 | 状态机（心脏） |
| `frontend/src/components/PlayerBar.tsx` | ~600 | 播放栏 + 全屏歌词 + PiP |
| `frontend/src/pages/SettingsPage.tsx` | ~700 | 设置（最大文件） |
| `frontend/src/components/FxPanel.tsx` | 251 | 音效面板 |
| `frontend/src/fx.ts` | 157 | 音效引擎 |
| `frontend/src/api.ts` | 58 | API 客户端 |
| `frontend/src/types.ts` | 60 | 类型定义 |
| `electron/main.js` | ~310 | 桌面壳 / 进程管理 |
