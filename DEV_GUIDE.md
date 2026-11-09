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
| [2. 后端 FastAPI](#2-后端-fastapi) | main / scanner / lyrics / models / separator / relinks / artist_info / setup_stem_models |
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

### 2.7 `backend/relinks.py` —— 相关视频检索（V13）

双击底栏歌名时，给这首歌找「现场版 / 优质翻唱」的外链。三个来源各解决一个不同的问题。

**两段式与"关窗不中断"**：`/api/relinks/{id}` 只负责首屏，补齐跑在
`_finish()` 的 daemon 线程里，**与 HTTP 请求/前端轮询无关**——关掉面板线程照样跑完。
首屏 `_assemble()` 之后立刻 `_disk_write(..., partial=True)` 落一份，补齐完成再用
`partial=False` 覆盖；`get_result()` 读到 `partial` 的缓存时会
`pending=True` + `_resume()` 续跑（`_jobs` 里已有任务则不重复排）。
所以"中途退出"最多损失一次补齐，B站结果不会丢。

**两个维度（scope）**

| scope | ident | 查询词来源 | 接口 | 落盘 |
|---|---|---|---|---|
| `song`（默认） | `song_id` | 歌名 + 歌手 | `/api/relinks/{id}` | `<相关视频>/<原文件名>.json` |
| `artist` | 歌手名 | 只要歌手名 | `/api/artist-relinks?name=` | `<相关视频>/歌手/<歌手名>.json` |

`get_result(ident, title, artist, filepath, force, scope)` 一个入口吃两种维度，
差异只在这几处：`_rule_queries()` / `plan_queries()` 的查询词、`label_ai()` 的提示词头部、
`_pre_rank()` 的匹配词（歌名 or 歌手名）、以及落盘目录。

**缓存 key 必须带 scope 前缀**（`f"{scope}:{ident}"`）：歌名和歌手名很可能同名
（比如一首歌就叫《周杰伦》），不带前缀会互相覆盖。磁盘目录也分开了，
`_rebuild_disk_index()` 会分别扫 `相关视频/` 和 `相关视频/歌手/`。

**为什么是三个来源，不能一个搞定**

| 需求 | 现实 | 对策 |
|---|---|---|
| B站视频链接 | `search/type` 被风控返回 HTML；`search/all/v2` 免登录可用 | 直接调 `search/all/v2`，拿 `bvid` 拼 `bilibili.com/video/BVxxx` |
| 抖音视频链接 | 官方接口要登录（`status_code 2483`）；网页是纯前端壳；搜索引擎 302 | **DeepSeek Search**（`/v1/tools/search` + `site:douyin.com`），Tavily 作备用 |
| 分类 + 打分 + 短评 | 关键词规则只能粗略归类 | **DeepSeek**（`deepseek-flash`）一次性给全部候选打标 |

**两段式返回（这是本模块最重要的一点）**

```
get_result() 第一次调用
  ├─ 同步（~1s）：规则查询词 → B站三路（现场/翻唱/MV）→ 规则打分 → 返回 pending=true
  └─ 后台线程（~15s）：DeepSeek 规划搜索词 → B站补一轮 + 抖音双查询 → DeepSeek 归类 → 落盘
```

前端每 2 秒轮询同一接口，`pending=false` 就停。这样做的原因是实测耗时分布：

| 阶段 | 耗时 |
|---|---|
| B站单查询 | 0.5–0.8s |
| DeepSeek 规划搜索词 | 0.6–2s |
| Tavily 抖音单查询 | **5–10s（偶发 SSL 握手超时）** |
| DeepSeek 归类 16 条候选 | 6–9s |

全都串在首屏就是 15 秒白屏，用户会以为点坏了。所以：

- **AI 规划搜索词挪到后台**——首屏用规则词（`歌名 歌手 现场` / `歌名 歌手 翻唱`）已经够用
- **抖音只走后台**——它是最慢的一环
- 30 分钟缓存（`_full_cache` / `_fast_cache` 两份，`clear_cache()` 供改 key 时清空）

**候选配额（踩过的坑）**

```python
BILI_KEEP = 10          # B站固定保底
DOUYIN_KEEP = 6         # 抖音固定上限
cands = bili[:10] + dy[:6]
```

最初写成 `bili[:MAX - len(dy)]`，结果抖音两个查询回来十几条时，B站配额被压到 4 条，
再经 AI 归类一筛，**现场版/翻唱里全是抖音，B站被挤没了**——正好违背"B站优先"的要求。
固定配额才稳。

**排序规则**

```python
for key in ["live", "cover", "mv", "other"]:      # 一级：现场 → 翻唱 → MV → 其他
    for src in ["bilibili", "douyin"]:            # 二级：B站 → 抖音
        picked += sorted(同组同源, key=score, reverse=True)[:PER_SRC_LIMIT]
picked = picked[:GROUP_MAX.get(key, 99)]          # MV 只留 1 条
```

另外「其他相关」有分数门槛（`score >= 50`），现场/翻唱放宽到 30，用来滤掉抖音返回的
无关片段（实测会把"周杰伦歌词见面那天"这类塞进来，AI 给 8 分，直接丢掉）。

**降级路径（三层）**

| 缺什么 | 影响 | 代码位置 |
|---|---|---|
| 没 Tavily key | 抖音结果为空，只显示 B站 | `search_douyin()` 直接 return `[]` |
| 没 DeepSeek key | 规则归类 + 播放量打分，`blurb` 为空，`ai=false` | `label_ai()` 开头 return |
| 接口超时/报错 | 该来源返回空列表，不影响其它来源 | 每个 provider 各自 try/except |

关键设计：**规则版永远先跑一遍**（`label_rule()`），AI 只是在它基础上复核。这样即使 AI 只
回来一半结果，另一半也有合理的分类和分数，不会出现空值。

**重试与兜底（都是踩坑后加的）**

- `search_douyin`：Tavily 偶发 SSL 握手超时，重试 1 次
- `label_ai`：DeepSeek 走系统代理，实测偶发 `Tunnel connection failed: 502`，
  重试 3 次、每次间隔 0.8s×n；三次都失败才退规则版，并在 `notes` 里说明
- **hint 兜底**：每条搜索结果带 `hint`（来自 live/cover/mv 哪条查询）。AI 挂了时，
  抖音那种只有 `#演唱会现场##live` 标签、没有"现场/翻唱"字样的条目不会掉进 other 被门槛滤掉
- **`_pre_rank` 候选粗排**：`歌名命中 +40 / 现场翻唱MV关键词 +20 / log10(播放量)×7`。
  只按播放量排会出事——实测《Mojito》时百万播放的"周杰伦串烧合集"挤掉了真正的演唱会片段
- **`_refine_cat` 归类校正**：AI 判完再按强关键词纠一次（同时含"现场"和"翻唱" → 归 cover）。
  AI 曾把"周杰伦本人演唱会现场"判成 other 打低分，导致现场版里一条 B站 都不剩

**网络韧性（这台机器上踩出来的，都是实测数据）**

| 现象 | 实测 | 对策 |
|---|---|---|
| 走 `HTTP_PROXY` 请求 B站 | **7.7s**（直连 0.5s，15 倍差距） | B站 请求用 `ProxyHandler({})` 直连，失败再回退代理 |
| 走代理请求 DeepSeek | 0.3–1.4s，但偶发 `Tunnel connection failed: 502` | 重试（归类 3 次 / 搜索 2 次） |
| B站 单次延迟抖动 | 1.6s / 3.6s / **25.6s** / 1.6s / 9.5s | **总预算制**：首屏 8s、补齐 12s，超时用已返回结果 |
| 归类 JSON 畸形 | `Expecting ',' delimiter`（模型偶发在字符串里塞引号） | `_salvage_items()` 用正则逐条抢救，抢救够多就继续用 |

总预算靠 `futures_wait(futs, timeout=SEARCH_BUDGET_FULL)` + `ex.shutdown(wait=False)` 实现。
**不能用 `with ThreadPoolExecutor()`**——它的退出会 `shutdown(wait=True)`，等所有慢请求跑完，
预算等于没用。

**播放量权重要给足**

`_rule_score` 的播放量档位从「1M +30」提到「5M +40 / 1M +34 / 300k +27」；`_pre_rank` 的
log 系数从 5 提到 7。AI 提示词也明确写了权重：相关性 40% / 热度 35% / 音质画质 25%，
并给播放量档位参考。群众的播放量是最稳的质量信号（B站 能拿到，抖音拿不到）。

**前端轮询不能一次失败就放弃**

`RelinkPanel` 早期版本在一次 `fetch` 失败后就停止轮询并显示"搜索失败：Failed to fetch"。
实际现场是 Vite 代理短暂中断（见 §6.4），后端并无问题。现在：连续失败退避重试 4 次
（1.2/2.4/3.6/4.8s），每次请求带 25s `AbortController` 超时，界面上区分
「自动重试中」（琥珀色）与「已失败 + 重试按钮」（红色）。

**key 存哪**

`backend/config.json` 的 `deepseek_api_key` / `tavily_api_key`，也支持环境变量
`DEEPSEEK_API_KEY` / `TAVILY_API_KEY`。config.json 已被 `.gitignore` 排除。
**入口在「设置 → 🔑 AI 接口密钥」**（`SettingsPage.tsx`），这样任何拿到这份代码的人
都能填自己的 key，而不是只有作者能跑。
`GET /api/config` **只回布尔值** `{"relink":{"deepseek":true,"tavily":false}}`，绝不回明文。

**三级缓存（因为搜索真实花钱）**

| 层 | 位置 | 容量 | 失效 |
|---|---|---|---|
| 任务态 | `_jobs`（内存） | 最多 4 个并发任务 | 任务结束即删 |
| 内存 LRU | `_mem`（OrderedDict） | **6 条** | 30 分钟 TTL / 被挤出 |
| 磁盘 | `<音乐目录>/相关视频/<原文件名>.json` | 不限 | **不自动过期**，靠刷新按钮 |

```python
_mem[song_id] = dict(data, _ts=time.time())
while len(_mem) > MEM_MAX:
    _mem.popitem(last=False)        # 淘汰最久未用的
```

早期版本只有一个永不过期的内存 dict，搜 200 首就积 200 份完整结果，重启还全丢——现在
内存只做"最近 6 首"的加速，真正的持久层是磁盘。首屏那份 `fast` 只挂在 `_jobs` 里，
`_finish` 的 `finally` 里 `_jobs.pop()` 顺手释放。

磁盘记录里存了 `caps`（当时有没有 key）：

```json
{ "version": 1, "song": {...}, "ai": true,
  "caps": {"deepseek": true, "tavily": true},
  "fetched_at": 1793310000, "total": 7, "groups": [...] }
```

读盘时若发现"当时没 key、现在有了"，判定为能力升级 → `return None` 触发重搜，
避免拿旧的规则版结果糊弄用户。`DISK_VERSION` 用于以后结构变更时整体作废旧缓存。

**`effort: "low"` 是实测结论**

DeepSeek V4 的 `deepseek-flash` 默认 `effort=high`。同一批 17 条候选分类：

| effort | 耗时 | completion_tokens |
|---|---|---|
| default(high) | 11.6s | 812 |
| **low** | **4.8s** | 851 |

分类任务本身简单，low 的产出质量看不出差别，所以 `_chat()` 固定传 `effort="low"`。

**B站结果播放量门槛**

```python
MIN_BILI_PLAY = 2000          # 低于这个播放量直接丢（随手拍/低质搬运太多）
def _min_bili_play():         # config.json 的 min_bili_play 可覆盖
```

在 `search_bilibili()` 里逐条过滤。副作用要清楚：**冷门歌可能全被滤空**，所以
`_assemble()` 在结果为 0 时会带一条提示说明当前阈值，避免用户以为功能坏了。

---

### 2.8 `backend/artist_info.py` —— 歌手简介（V13.5）

**选源结论**（都实测过）：

| 来源 | 结论 |
|---|---|
| **网易云** `api/v1/artist/<id>` | ✅ 免费、无需 key、国内直连、中文 `briefDesc` 头部歌手 600+ 字 |
| 维基百科 REST | ❌ 数据干净但国内直连不通（无代理必失败） |
| MusicBrainz | ❌ 免费但要英文名，中文歌手简介基本为空 |
| 百度百科 | ❌ 无官方 API，抓 HTML 会被反爬拦 |

**两步接口**

```
api/search/get?s=<歌手>&type=100&limit=5   → artist id / picUrl / fansSize
api/v1/artist/<id>                        → briefDesc / alias / musicSize / albumSize
```

注意：`/api/artist/<id>`（不带 v1）的 `briefDesc` 是空的，**必须用 `/api/v1/artist/<id>`**；
`/api/artist/desc?id=` 直接返回 `{"code":400,"msg":"参数错误"}`。这三个接口长得像，别用错。

**简介质量校验（必须做）**

`briefDesc` 是歌手/编辑自己填的。实测：

- 周杰伦 665 字、Beyond 685 字 —— 正常
- 万能青年旅店 76 字 —— 短但可用
- **陈粒是 `ok…………………………`** —— 纯垃圾

所以 `_clean_brief()` 三道闸：长度 < 10 → 丢；中文字符 < 5 → 丢；字符种类 ≤ 6 → 丢。
判为无效后 `brief` 返回空字符串，前端显示「暂无简介」，不会把垃圾文本摆出来。

**缓存**

按歌手名直接命名文件（`<音乐目录>/歌手简介/<歌手>.json`），**不需要索引**——
key 本身就是歌手名，这点比 relinks 简单（那边 key 是 song_id，落盘名是歌曲文件名，才需要建索引）。
简介几乎不变，所以磁盘不自动过期；查不到的只做 10 分钟内存负缓存，不落盘。

内存 LRU 只留 8 条，与 relinks 同样的考虑：不长期吃内存。

---

### 2.9 `backend/melody.py` —— 旋律提取（V14）

**核心结论：必须用人声轨。** 实测在《晴天》混音上跑 pyin，中位音高 82Hz —— 那是贝斯，
不是人声；和 vocals 轨的一致率只有 37%。所以本模块只读
`separator.stems_path(song_id, "vocals")`，没分离过直接返回 `no_vocals`。

| 检测器 | 4:48 的歌 | 备注 |
|---|---|---|
| **CREPE**（torchcrepe） | **23s**（RTX GPU） | 主力，`return_periodicity=True` 拿置信度 |
| librosa.pyin | 140s | 兜底，无 torch 时用 |

两个坑：

1. 这个版本的 `torchcrepe.predict()` **没有 `verbose` 参数**，而且默认
   **只返回 pitch 一个值**，要置信度必须显式 `return_periodicity=True`。
2. `torchcrepe/load.py` 顶部 `import torchaudio`（只用于读文件）。我们的音频走
   librosa 解码，所以在模块里塞一个最小 stub 占住 `sys.modules['torchaudio']`，
   免得为了这一行 import 装 100MB 的 torchaudio。

**曲线 → 音符**：f0 → MIDI（`69 + 12*log2(f/440)`）→ 量化到半音 → 同音粘连
（间隔 <100ms 合并，气口不该把一句话切碎）→ 丢 <70ms 短音 → `_drop_octave_outliers()`
清掉"短音且和周围 1 秒中位音高差 ≥10 个半音"的倍频误判。

**按句对齐**：LRC 是逐行时间戳，所以每行取 `[本行起点, 下一行起点)` 区间内的音符。
要做到全民K歌那种逐字高亮，需要强制对齐（WhisperX/MFA），成本高一个量级，暂不做。

缓存 `<音乐目录>/旋律/<原文件名>.json`（只存音符，不存原始 f0 曲线——后者一首歌
两万多个浮点，没必要）。

---

### 2.10 皮肤与桌面歌词（V14.5）

**皮肤 = 一组 CSS 变量**，挂在 `<html data-skin>` 上（`frontend/src/skin.ts` 管理，存 localStorage）。
关键点：**不要为了皮肤去改组件**。项目里按钮/进度条/选中态早就在用 `var(--accent)`，
所以只要在各皮肤块里覆盖 `--accent` / `--skin-surface` / `--skin-border` / `--skin-ribbon`，
它们就一起变了。

桌面歌词是独立 html 窗口，读不到主窗口的 CSS 变量 → `PlayerBar.readPipSkin()` 把
`--accent` / `--skin-surface` 算成具体色值，随 `lyric-config` 一起 IPC 过去。

**桌面歌词锁定**：`lyric-lock` IPC → `win.setIgnoreMouseEvents(true, { forward: true })`
（forward 让鼠标事件穿透到桌面而不是被吞掉），同时给窗口发 `lyric-lock` 让它把
`-webkit-app-region` 从 drag 改成 no-drag。锁住后窗口点不到，所以解锁入口只放设置页；
`createLyricWindow()` 的 `did-finish-load` 里会重新 `applyLyricLock()`，重建窗口不丢状态。

**锁定状态的三处同步**：`frontend/src/pipLock.ts` 是唯一入口——写 localStorage +
`lyricLock()` 通知主进程 + 广播 `haizhe-pip-lock` 自定义事件；
桌词窗口里点的锁由主进程用 `lyric-lock-state` 回推给主窗口（否则主窗口的解锁条永远不出现）。

**锁定时为什么收不到 hover**：`setIgnoreMouseEvents(true, {forward:true})` 让事件整体穿透，
网页侧收不到任何鼠标事件。所以"悬停 3 秒出解锁键"由**主进程每 200ms 轮询
`screen.getCursorScreenPoint()`** 实现：
- 光标在**整个窗口矩形**内连续停留 `DWELL_MS=3000` → 临时 `setIgnoreMouseEvents(false)`
  + 推 `lyric-lock-hint` 显示 🔓；
- 移出窗口后给 `GRACE_MS=4000` 宽限再收回穿透（否则手一抖移出就点不到，体验很差）。

⚠️ 别把判定做成"右上角小块热区"：窗口是自适应的，热区很难对准，
而且手动去找那 44×30 的过程中会频繁进出判定区，表现为"悬停没反应、离开才出现"。

**桌词宽度自适应**：`fitWidth()` 用隐藏 span 按"大字号"量当前行+下一行，取最大值。
上限取 `screen.availWidth`（**不能用 `window.innerWidth`**——窗口会随内容变宽，形成反馈循环）。
放不下时按 `slack = SCREEN_MAX - PAD` 算缩放系数，写进 `--fit`，行字号统一乘它。
⚠️ 内边距**不能**参与缩放，否则盒子比文字还窄，反而会截断（踩过）。
宽度变化通过 `lyric-resize-w` 通知主进程，以中心为锚左右扩。

**桌面歌词的滚动**：原来是直接改 `textContent`，换句瞬间闪一下。现在改成三行舞台
（prev / cur / next）+ `translateY` 动画：

```
#stage { transform: translateY(-1 * rowH) }   /* 静止时第 2 行在顶部 */
换句 → translateY(-2 * rowH)（整列上滑一格，新行同时变亮）
430ms 后：内容整体上移一格 + 瞬時复位 translateY(-1 * rowH)，视觉无跳变
```

要点：**行高必须是固定值**（`--rowH`），字号变化只影响行内文字，不影响行高，
否则动画过程中高度变化会抖。`busy` 标志防止快速换句时动画打架（只保留最后一次）。

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

### 5.3 `components/RelinkPanel.tsx`（~250 行）

双击底栏歌名弹出。结构与 `FxPanel` 同源（锚定 + 外部点击关闭），但多了两件事：

**① 自己的 pending 轮询**

```typescript
const tick = async () => {
  const r = await api.getRelinks(songId);
  setData(r);
  if (r.pending && tries < 12) {   // 最多 12 轮 ≈ 24s
    tries += 1;
    timer = setTimeout(tick, 2000);
  }
};
```

和后端两段式配套：先渲染 B站结果，抖音/AI 补齐后自动替换。`aliveRef` 防止面板关闭后回调写状态。

**② 外链跳转的降级**

```typescript
async function openLink(url: string) {
  const ea = (window as any).electronAPI;
  if (ea?.openExternal) { if (await ea.openExternal(url)) return; }
  window.open(url, '_blank', 'noopener,noreferrer');   // 网页版
}
```

Electron 侧 `ipcMain.handle('open-external')` 会用 `shell.openExternal`，并**只放行 http/https**
（`new URL()` 校验协议），防止 `file://` 或自定义协议被拼进来。

**布局**：`absolute bottom-16` + `useLayoutEffect` 算 left（对齐歌名块、clamp 在视口内），
内容区 `max-h-[58vh] overflow-y-auto`。与 FxPanel 的差异是它左对齐锚点、宽度 460px。

### 5.4 `components/PlayerBar.tsx`（~600 行）

最复杂的组件：底部播放栏 + 全屏歌词 + PiP + 效果按钮。

- `state.playbackRate !== 1 || pitchSemitones !== 0 || chipmunk || stem !== 'original'` → "效果"按钮高亮，提示当前有音效在生效
- 全屏封面的 cleanup：`coverRef.current.src = ''`，配合 `key` 强制卸载释放 Chromium 解码位图

### 5.5 背景与字体系统

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

### 5.6 `pages/SettingsPage.tsx`（~25KB，最大的文件）

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

### 6.4 子进程日志与自愈（V13.1，一次真实故障倒逼出来的）

**故障现象**：应用开着，界面还在，但音乐不播、双击歌名显示「搜索失败：Failed to fetch」。

**根因**：`startFrontend()` spawn 的 Vite 进程没了。前端所有 `/api` 请求都走 Vite proxy
（`frontend/src/api.ts` 用相对路径 + `vite.config.ts` 的 proxy），代理一死 →
渲染进程全部请求失败、`<audio>` 拉不到流。**后端 8765 一直是健康的**。

**为什么当时查不出来**：两个子进程都是 `stdio: 'ignore'`，Electron 又是无窗口启动，
`console.error` 没有落点，`desktop.log` 里只有 Python 的 DeprecationWarning。零线索。

**现在的做法**：

```javascript
// 日志：每次启动重建 logs/backend.log、logs/frontend.log
openLogs();
backendProc  = spawn('python', ['main.py'], { stdio: childStdio(backendLog),  ... });
frontendProc = spawn('node',   [viteJs, ...],  { stdio: childStdio(frontendLog), ... });

// 自愈：非主动退出 → 最多重启 3 次；活过 60 秒重置计数
if (quitting) return;                                  // cleanup() 里先置 true
if (Date.now() - startedAt > 60000) frontendRestarts = 0;
setTimeout(() => { if (!quitting) startFrontend(); }, 2000);
```

两个细节：

- **`quitting` 必须在 `killProcTree()` 之前置位**，否则退出应用时 taskkill 触发的 `exit`
  会把子进程又拉起来
- **重启要计上限**：端口被占用（`EADDRINUSE`）会立刻退出，不设上限就是无限刷

**配套改动：桌面端不再依赖 Vite proxy**

```typescript
// frontend/src/api.ts
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;
export const API_BASE = isElectron ? 'http://127.0.0.1:8765' : '';
```


页面在 Electron 里本来就跑在本机，直连后端最稳：Vite 再挂，播放与搜索照常。
网页版（含手机同 WiFi 访问）仍用相对路径，必须靠 proxy。
注意 `SettingsPage` / `RelinkPanel` 里的裸 `fetch('/api/...')` 也要用 `API_BASE` 拼，
否则只改 `api.ts` 是半套。

**另一个坑：GUI 启动时 PATH 和终端不一样**

双击快捷方式启动的 Electron 继承的是 explorer 的 PATH，`python` 可能解析到
**没装 fastapi 的那个解释器**（本机实测：PATH 上的 `python` 是 3.13.14，没有 fastapi；
`D:\Anaconda\python.exe` 是 3.9.13，才有 fastapi 和 mutagen）。
`spawn('python')` 因此会在启动瞬间失败，而旧代码 `stdio:'ignore'` 下一点痕迹都没有，
用户看到的就是**黑屏**。

现在 `pickPython()` 按优先级探测（Anaconda 优先，最后才退回 PATH），并把结果写进日志：

```
[env] python = Python 3.9.13  (D:\Anaconda\python.exe)
[spawn] pid=12345 exe=D:\Anaconda\python.exe cwd=...\backend
```

另外 `did-fail-load` 重试 5 次仍失败时，会加载一张说明页（而不是留一片黑屏），
直接告诉你去看哪两个日志文件。

**排查同类问题的最短路径**：

```bash
netstat -ano | grep -E ":(8765|5173)\s+.*LISTENING"     # 谁在谁不在
curl -s -m5 http://127.0.0.1:8765/api/status            # 直连后端，绕过 Vite
curl -s -r 0-1023 -o /dev/null -w "%{http_code}\n" \
     http://127.0.0.1:8765/api/stream/<song_id>         # 流媒体是否真能出字节
```

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
| `backend/relinks.py` | ~430 | 相关视频检索（B站/抖音/AI 排序，两段式） |
| `backend/artist_info.py` | ~200 | 歌手简介（网易云接口 + 质量校验 + 落盘缓存） |
| `backend/melody.py` | ~250 | 旋律提取（人声轨 → CREPE/pyin → 音符 → 按句切分） |
| `backend/setup_stem_models.py` | ~500 | HQ 模型下载 + PoPE 补丁 |
| `backend/lyrics.py` | ~50 | LRC 解析 |
| `backend/models.py` | ~30 | Pydantic 模型 |
| `frontend/src/store.tsx` | 609 | 状态机（心脏） |
| `frontend/src/components/PlayerBar.tsx` | ~600 | 播放栏 + 全屏歌词 + PiP |
| `frontend/src/pages/SettingsPage.tsx` | ~700 | 设置（最大文件） |
| `frontend/src/components/FxPanel.tsx` | 251 | 音效面板 |
| `frontend/src/components/RelinkPanel.tsx` | ~250 | 相关视频面板（双击歌名触发，自带 pending 轮询） |
| `frontend/src/fx.ts` | 157 | 音效引擎 |
| `frontend/src/api.ts` | 58 | API 客户端 |
| `frontend/src/types.ts` | 60 | 类型定义 |
| `electron/main.js` | ~310 | 桌面壳 / 进程管理 |
