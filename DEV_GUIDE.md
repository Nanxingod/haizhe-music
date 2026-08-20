# 🎵 海蜇音乐播放器 —— 代码细节指南

> 本文档是 README.md 的姊妹篇。README 讲框架，本文档讲细节。
> 逐文件、逐函数地说明每一行代码在做什么、为什么这么做、和其他部分如何交互。

---

## 目录

1. [项目概览](#1-项目概览)
2. [启动脚本详解](#2-启动脚本详解)
3. [Electron 桌面壳层](#3-electron-桌面壳层)
4. [Python 后端](#4-python-后端)
5. [React 前端核心](#5-react-前端核心)
6. [前端组件](#6-前端组件)
7. [前端页面](#7-前端页面)
8. [全局样式系统](#8-全局样式系统)
9. [构建与打包配置](#9-构建与打包配置)
10. [数据流全景](#10-数据流全景)
11. [内存管理策略](#11-内存管理策略)

---

## 1. 项目概览

| 属性 | 值 |
|------|-----|
| 名称 | `haizhe-music` — 海蜇音乐播放器 |
| 版本 | 1.0.0 (V10.1 稳定版) |
| 技术栈 | Python 3.9+ FastAPI + React 19 + TypeScript + Electron 39 |
| 核心库 | mutagen (MP3/ID3), uvicorn (ASGI), Tailwind CSS (样式), Framer Motion (动画) |
| 规模 | 40+ 源文件，核心代码约 2600 行 (不含 node_modules) |

### 架构三层

```
Electron Shell  ← 窗口管理 · 子进程生命周期 · IPC · 桌面歌词透明窗口
     │
React 前端     ← UI 渲染 · 播放器状态 · 歌词同步 · 背景/字体配置
     │ HTTP (localhost:8765)
FastAPI 后端   ← MP3 扫描 · 流媒体 · 封面 · LRC 解析
```

三层之间的纽带是 HTTP。Electron 启动时 `spawn` 后端 (Python) 和前端 (Vite)，前端通过 Vite proxy 访问后端 API。

---

## 2. 启动脚本详解

### 2.1 `start.bat` — 网页版启动

```batch
# 步骤拆解：
1. 强制杀掉端口 8765 上的旧进程 (netstat → taskkill)
2. start /b /min → 后台最小化启动 python main.py (后端)
3. 等待 3 秒
4. start /b /min → 后台最小化启动 npx vite (前端)
5. 等待 2 秒
6. 打开浏览器 → http://localhost:5173
```

关键点：
- `/b` 参数让 `start` 不打开新命令行窗口
- `>nul 2>&1` 将 stdout 和 stderr 都丢弃，保持安静
- 两次 `timeout` 确保后端先启动完毕，前端再启动

### 2.2 `start-desktop.bat` — Electron 桌面版启动

```batch
# 步骤：
1. npx electron . > desktop.log 2>&1 → 启动 Electron（输出写日志）
2. Electron main.js 内部：单实例锁 → 清理残留端口 → spawn 后端/前端
```

和网页版的区别：
- **不手动启动** 后端/前端 — Electron 的 `main.js` 会自己 `spawn`
- **端口清场已移入 main.js**（`killPortOccupants`）：拿到单实例锁之后才执行，
  重复启动不会误杀在线实例的后端；上次被强杀的孤儿进程下次启动时自动清理
- 崩溃排查看 `desktop.log`（每次启动覆盖写入）

### 2.3 `start-desktop.vbs` — 无窗口启动器

```vbscript
Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & strDir & "\start-desktop.bat""", 0, False
```

`0` 表示隐藏窗口。双击 `.vbs` 不会弹出命令行黑框，适合放进系统自启动。

> ⚠️ **V11 踩坑记录**：此文件必须保持 **纯 ASCII**。wscript 按系统 ANSI 代码页
> （中文系统 = GBK）解析 `.vbs`，UTF-8 中文注释会让引号/换行错位，报
> `缺少对象: 'fso'` 之类诡异错误。旧版还误用过批处理语法 `%~dp0`（VBS 不展开），
> 导致无窗口启动从未生效过——这就是"双击快捷方式总弹终端"的根源。

### 2.4 `setup-first-run.bat` — 首次安装依赖

检查系统是否有 Python 3.9+，然后执行：
```bash
pip install fastapi uvicorn mutagen aiofiles
```

### 2.5 `create-shortcut.ps1` — 桌面快捷方式

PowerShell 脚本，创建 `wscript.exe start-desktop.vbs` 的 `.lnk` 快捷方式
（完全无终端启动），图标使用 `electron/icon.ico`。路径基于 `$PSScriptRoot`，
项目目录移动后重跑一次即可。

---

## 3. Electron 桌面壳层

### 3.1 `electron/main.js` (204 行) — 主进程

这是 Electron 应用的大脑，负责进程生命周期和窗口管理。

#### Chromium GC 配置

```js
app.commandLine.appendSwitch('js-flags', '--expose-gc');
```

启用 `window.gc()` 方法，配合后面的闲置 GC timer 使用。不会影响 GPU 内存（图片/纹理由后端封面缩放策略控制）。

#### 后端启动 `startBackend()` (第 19–28 行)

```js
const isDev = !app.isPackaged;
const backendDir = isDev
  ? path.join(__dirname, '..', 'backend')        // 开发: electron/../backend/
  : path.join(process.resourcesPath, 'backend');  // 打包: resources/backend/
backendProc = spawn('python', ['main.py'], {
  cwd: backendDir, stdio: 'ignore', windowsHide: true, shell: true,
});
```

- `app.isPackaged` 判断开发/打包环境，路径不同
- `windowsHide: true` 不让 Python 窗口闪烁
- `stdio: 'ignore'` 不捕获子进程输出

#### 前端启动 `startFrontend()` (第 31–37 行)

```js
if (app.isPackaged) return; // V11: 打包版直接加载 frontend/dist，不再拉 Vite
frontendProc = spawn('npx', ['vite', '--host', '0.0.0.0'], {
  cwd: path.join(__dirname, '..', 'frontend'),
  stdio: 'ignore', windowsHide: true, shell: true,
});
```

`--host 0.0.0.0` 让 Vite 绑定所有网络接口，支持局域网访问。

#### 子进程清理 `cleanup()` (V11 重写)

`shell: true` 时 spawn 出来的是 **cmd 壳进程**，`proc.kill()` 只能杀壳，
Python / Vite 会变孤儿进程继续占用端口。V11 改为 Windows 下
`taskkill /pid <pid> /T /F` 杀整棵进程树（`killProcTree()`），退出后端口
干净释放。也负责关闭桌面歌词窗口。

#### 桌面化改造（V11 新增）

| 机制 | 代码 | 作用 |
|------|------|------|
| AppUserModelId | `app.setAppUserModelId('com.haizhe.music')` | 任务栏分组身份，与 electron-builder appId 一致 |
| 窗口图标 | `BrowserWindow({ icon: electron/icon.ico })` | 任务栏/标题栏显示自定义图标（开发模式不再显示 Electron 默认图标） |
| 单实例锁 | `requestSingleInstanceLock()` | 重复启动 → 聚焦已有窗口并退出新实例 |
| 端口清场 | `killPortOccupants()`（启动时） | 清理上次强杀留下的孤儿进程；仅在拿到单实例锁后执行 |

#### URL 就绪轮询 `waitForUrl()` (第 68–87 行)

```js
function waitForUrl(url, timeoutMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    // HTTP GET 请求 → 成功则 resolve → 失败则 500ms 后重试 → 超时则 reject
  });
}
```

- 前端：30 秒超时，500ms 间隔
- 后端：60 秒超时，1000ms 间隔 (后端启动较慢)

#### 主窗口 `createMainWindow()` (第 90–131 行)

核心配置：

| 属性 | 值 | 说明 |
|------|-----|------|
| `frame` | `false` | 无边框，由 React 的 `TitleBar` 组件绘制 |
| `backgroundColor` | `#0a0a12` | 避免白屏闪烁 |
| `backgroundThrottling` | `true` | 后台时降低渲染频率，省资源 |
| `contextIsolation` | `true` | 安全隔离 |
| `nodeIntegration` | `false` | 渲染进程不能直接访问 Node |

**闲置 GC timer** (第 107–116 行)：
```js
const gcInterval = setInterval(() => {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.isFocused()) {
    mainWin.webContents.executeJavaScript('window.gc && window.gc()');
  }
}, 180000);
```
- 每 3 分钟触发一次
- **仅在窗口未聚焦时** — 避免干扰用户体验
- 释放 Chromium 的 JS 堆碎片和图片解码缓冲

#### 桌面歌词窗口 `createLyricWindow()` (第 134–156 行)

```js
lyricWin = new BrowserWindow({
  width: 500, height: 80,
  frame: false, transparent: true,      // 透明无边框
  alwaysOnTop: true, skipTaskbar: true,  // 置顶 + 不在任务栏显示
  backgroundColor: '#00000000',          // 完全透明背景
  webPreferences: { nodeIntegration: true, contextIsolation: false },
});
lyricWin.setAlwaysOnTop(true, 'screen-saver');  // 比普通窗口更高层级
```

**`lyricReady` 标志位 + `pendingLyricCfg` 暂存**：
```
时间线问题：
  用户开启桌面歌词 → createLyricWindow() → lyrics.html 开始加载
  用户立即调整颜色 → ipcMain 收到 lyric-config
  但 lyrics.html 还没加载完成 → 消息被丢弃 → 窗口永远看不到配置

解决方案：
  窗口加载期间 → config 存入 pendingLyricCfg
  加载完成 (did-finish-load) → 读取 pendingLyricCfg → 发送给窗口
```

#### IPC 处理 (第 159–172 行)

| IPC 通道 | 方向 | 作用 |
|----------|------|------|
| `window-minimize` | renderer → main | 最小化主窗口 |
| `window-maximize` | renderer → main | 切换最大化 |
| `window-close` | renderer → main | 关闭主窗口 |
| `lyric-show` | renderer → main | 创建/显示歌词窗口 |
| `lyric-hide` | renderer → main | 关闭歌词窗口 |
| `lyric-update` | renderer → main → lyricWin | 转发歌词文本到歌词窗口 |
| `lyric-config` | renderer → main → lyricWin | 转发样式配置到歌词窗口 |

#### 应用生命周期 (第 175–203 行)

```
app.whenReady()
  → startBackend()          # 启动 Python
  → startFrontend()          # 启动 Vite
  → waitForUrl(5173)         # 等前端就绪
  → waitForUrl(8765/status)  # 等后端就绪
  → createMainWindow()       # 创建主窗口
  → 注册信号处理器 (exit/SIGINT/SIGTERM)

window-all-closed → cleanup() → app.quit()
before-quit → cleanup()
```

### 3.2 `electron/preload.js` (19 行) — IPC 桥接

```js
contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制: minimize/maximize/close/isMaximized/onMaximizeChange
  // 桌面歌词: lyricShow/lyricHide/lyricUpdate(data)/lyricConfig(cfg)
});
```

通过 `contextBridge` 安全暴露 IPC 接口到渲染进程。前端通过 `window.electronAPI` 调用。

### 3.3 `electron/lyrics.html` (62 行) — 桌面歌词窗口页面

独立的 HTML 页面，运行在独立的 BrowserWindow 中，不经过 React。

```html
<!-- 布局: 两个 <span> 上下排列，flex 居中 -->
<span id="cur">当前歌词行</span>
<span id="next">下一行预览</span>
```

IPC 监听：
- `lyric-data`：更新 `#cur` 和 `#next` 的文本内容
- `lyric-config`：动态注入 CSS 样式 (背景深度、颜色、字号、字体)

样式特点：
- `-webkit-app-region: drag` — 整个窗口可拖拽 (但文字本身 `user-select: none`)
- 默认配色：`#ff9eaf` 粉色文字 + `text-shadow: 0 0 10px #ff9eaf44` 发光效果
- 当前行 22px 粗体，下一行 18px 40% 透明度

---

## 4. Python 后端

### 4.1 `backend/config.json` — 音乐目录配置

```json
{ "music_dir": "D:\\Music\\lxmusic" }
```

唯一的外部配置。修改此路径指向你的音乐文件夹。

### 4.2 `backend/requirements.txt` — Python 依赖

```
fastapi>=0.100.0     # Web 框架
uvicorn[standard]>=0.23.0  # ASGI 服务器
mutagen>=1.46.0      # MP3/ID3 标签解析
aiofiles>=23.0       # 异步文件 I/O
```

### 4.3 `backend/models.py` (33 行) — Pydantic 数据模型

定义四个核心数据结构和它们的字段约束：

#### `Song` — 歌曲
```python
class Song(BaseModel):
    id: str              # MD5(相对路径)[:12]
    title: str           # 从文件名解析的歌曲名
    artist: str          # 原始歌手字符串（如 "徐良、阿悄"），用于显示
    artists: list[str]   # 拆分后的独立歌手列表（如 ["徐良", "阿悄"]），用于搜索/分类
    file_path: str       # MP3 文件绝对路径
    lrc_path: Optional[str] = None  # LRC 歌词文件路径
    has_cover: bool      # MP3 是否内嵌封面 (ID3 APIC 帧)
    has_lrc: bool        # 同目录是否有 .lrc 文件
    duration: Optional[float] = None  # MP3 时长（秒）
```

#### `Artist` — 歌手
```python
class Artist(BaseModel):
    name: str
    song_count: int
    cover_song_id: Optional[str] = None  # 第一首有封面的歌曲 ID，用作头像
```

#### `LyricsLine` / `Lyrics` — 歌词
```python
class LyricsLine(BaseModel):
    time: float  # 秒数
    text: str    # 歌词文本

class Lyrics(BaseModel):
    lines: list[LyricsLine]
    ti: Optional[str] = None  # 歌曲标题（LRC 元数据标签）
    ar: Optional[str] = None  # 歌手名
    al: Optional[str] = None  # 专辑名
```

### 4.4 `backend/scanner.py` (189 行) — MP3 扫描器

整个后端最核心的文件，负责发现歌曲、提取元数据、预生成封面缩略图。

#### `_load_music_dir()` (第 17–32 行)
从 `config.json` 读取音乐目录，如果配置不存在或路径不可用，回退到 `D:\Music\lxmusic`。

#### `_split_artists()` + `ARTIST_SPLIT_RE` (第 40–46 行)
```python
ARTIST_SPLIT_RE = re.compile(r"[、,，/&]|\bfeat\.?\b", re.IGNORECASE)
```
匹配的分隔符：
- `、` `,` `，` `/` `&` — 标准分隔符
- `feat.` / `feat` — 英文合作标记 (大小写不敏感)

拆解例子：
```
"徐良、阿悄"     → ["徐良", "阿悄"]
"汪苏泷 / BY2"  → ["汪苏泷", "BY2"]
"周杰伦 feat. 蔡依林" → ["周杰伦", "蔡依林"]
```

#### `_parse_filename()` (第 49–55 行)
文件名格式：`{歌名} - {歌手}.mp3`
```python
parts = name.rsplit(" - ", 1)  # 从右边开始按 " - " 分割，仅切一次
# "有何不可 - 许嵩.mp3" → ("有何不可", "许嵩")
```

#### `_file_id()` (第 58–60 行)
```python
relative = filepath.relative_to(MUSIC_DIR)
return hashlib.md5(str(relative).encode()).hexdigest()[:12]
```
生成 12 位 hex ID。使用相对路径的 MD5，而不是绝对路径，这样更换音乐目录根路径时 ID 不会变。

#### `_get_duration()` (第 63–68 行)
使用 mutagen 读取 MP3 时长：
```python
audio = MP3(filepath)
return audio.info.length
```

#### `_extract_and_cache_cover()` (第 71–85 行)
封面提取的两步策略：
1. 检查磁盘缓存是否已有 `.jpg` 文件 → 有则跳过
2. 从 MP3 的 ID3 APIC 帧读取原始图片数据
3. 调用 `_save_thumbnail()` 缩放到 150px JPEG 存盘

#### `_save_thumbnail()` (第 88–110 行)
图片处理的细节：
```python
img = Image.open(BytesIO(data))
img.thumbnail((size, size), Image.LANCZOS)    # 等比缩放，不超过 150×150
# RGBA 透明图 → 白底合成
# P (调色板) 模式 → 先转 RGBA 再白底合成
# 其他模式 → 转 RGB
img.save(dest, format='JPEG', quality=82, optimize=True)
```
- `LANCZOS` 是高质量缩放算法
- `quality=82` 平衡质量和文件大小
- `optimize=True` 进一步压缩

#### `scan_all()` (第 113–178 行) — 主扫描流程

```
1. 确保 cache/covers/ 目录存在
2. 列出 MUSIC_DIR 下所有 .mp3 文件
3. 遍历每个文件：
   a. 文件名解析 → title, raw_artist
   b. 多歌手拆分 → individual
   c. 计算 file_id
   d. 查找同名 .lrc 文件
   e. 提取封面缩略图到磁盘缓存
   f. 获取时长
   g. 构造 Song 对象
   h. 按歌手分组到 artist_songs 字典
   i. 每 100 首输出进度
4. 按歌曲数降序排列歌手
5. 返回 (songs, artists)
```

#### `get_songs_by_artist()` (第 181–183 行)
```python
return [s for s in songs if artist in s.artists]
```
使用 `in` 运算符匹配，意味着一首歌可能出现在多个歌手的页面中（合作歌曲）。

#### `search_songs()` (第 186–189 行)
```python
q = query.lower()
return [s for s in songs if q in s.title.lower() or q in s.artist.lower()]
```
大小写不敏感，同时搜歌名和歌手字段。时间复杂度 O(n)，当前 676 首足够用。

### 4.5 `backend/lyrics.py` (55 行) — LRC 歌词解析器

#### 正则表达式

```python
LRC_TIME_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]")
# 匹配 [03:45.67] 或 [3:45]
# group(1) = 分钟, group(2) = 秒, group(3) = 毫秒 (可选)

LRC_TAG_RE = re.compile(r"\[(ti|ar|al|by|offset):(.+)\]", re.IGNORECASE)
# 匹配元数据标签 [ti:歌曲名] [ar:歌手] [al:专辑]
```

#### `parse_lrc()` (第 11–55 行)

```python
# 对每一行：
1. 检查是否元数据标签行 → 存入 tags 字典
2. 查找所有时间标签 [mm:ss.xx]
3. LRC 格式支持一行多个时间标签：
   "[01:02]第一句[01:10]第二句" → 生成两条 LyricsLine
4. 毫秒处理：ms.ljust(3, "0")[:3] 保证 3 位
5. 时间计算：minutes * 60 + seconds + ms / 1000.0
6. 最终按时间升序排列
```

### 4.6 `backend/main.py` (244 行) — FastAPI 服务

运行在 `localhost:8765`。

#### 中间件

```python
app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)
app.add_middleware(GZipMiddleware, minimum_size=500)
```
- CORS 全开放（本机 + 局域网）
- 响应 > 500 字节自动 gzip 压缩（JSON 列表响应受益很大）

#### 全局状态

```python
ALL_SONGS: list[Song] = []
ARTISTS: list[Artist] = []
```
两个全局变量，启动时由 `scan_all()` 填充。这是简单单进程方案，足够个人使用。

#### 启动事件

```python
@app.on_event("startup")
async def startup():
    ALL_SONGS, ARTISTS = scan_all()
```
FastAPI 启动时自动扫描音乐目录。

#### API 端点一览

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/artists` | 返回所有歌手 |
| GET | `/api/artists/{name}` | 返回某歌手的全部歌曲 |
| GET | `/api/songs?search=&limit=&offset=` | 歌曲搜索/分页 |
| GET | `/api/songs/{id}` | 歌曲详情 |
| GET | `/api/stream/{id}` | MP3 流媒体 |
| GET | `/api/cover/{id}?size=` | 封面图片 |
| GET | `/api/lyrics/{id}` | 歌词 |
| GET | `/api/bg-images/{area}` | 背景图列表 |
| GET | `/api/status` | 服务状态 |
| POST | `/api/refresh` | 重新扫描 |

#### `_song_public()` (第 50–55 行)
```python
def _song_public(s: Song) -> dict:
    return { "id": s.id, "title": s.title, "artist": s.artist,
             "artists": s.artists, "has_cover": s.has_cover,
             "has_lrc": s.has_lrc, "duration": s.duration }
```
对外返回时去掉 `file_path` 和 `lrc_path`，不暴露文件系统路径。

#### 流媒体实现 `stream_audio()` (第 86–134 行)

这是 HTTP Range 请求的标准实现：

```python
STREAM_BUF = 128 * 1024  # 128KB 块读取

# 解析 Range: bytes=start-end
range_match = re.match(r"bytes=(\d+)-(\d*)", range_header)
start = int(range_match.group(1))
end = int(end_str) if end_str else file_size - 1

# 生成器函数：逐块读取
def file_iterator():
    with open(filepath, "rb") as f:
        f.seek(start)
        remaining = chunk_size
        while remaining > 0:
            buf = f.read(min(STREAM_BUF, remaining))
            if not buf: break
            remaining -= len(buf)
            yield buf

# 返回 206 Partial Content
return StreamingResponse(file_iterator(), status_code=206,
    headers={"Content-Range": f"bytes {start}-{end}/{file_size}", ...})
```

**为什么用 128KB 块？**
- 10MB MP3 文件，小缓冲区 (如 8KB) 会产生 ~1280 次 `read()` 调用，大缓冲区减少 I/O 次数
- 128KB 平衡了 I/O 效率和响应延迟
- 浏览器拖拽进度条时，只需从新偏移量 seek 读取，无需重启

#### 封面系统 `get_cover()` (第 152–180 行)

两级加载策略：

```
size < 800 (列表/缩略图)：
  → 从 COVER_CACHE_DIR/{song_id}.jpg 直接返回
  → FileResponse 直接从磁盘 → < 5ms
  → 缓存头 Cache-Control: max-age=86400 (浏览器缓存 24 小时)

size = 800 (全屏播放页)：
  → 从 MP3 ID3 APIC 帧按需提取原图
  → _extract_raw_cover() 返回原始 bytes + mime
  → 不缓存磁盘 (仅全屏时用，用完即释放)
  → 缓存头 max-age=3600 (1 小时)
```

#### 定时 GC (第 225–234 行)

```python
async def periodic_gc():
    while True:
        await asyncio.sleep(300)     # 每 5 分钟
        collected = gc.collect()     # 强制垃圾回收
        if collected > 0:
            print(f"[GC] 回收 {collected} 个对象")
```

Python 端的内存管理。配合 `limit_concurrency=50` 和 `limit_max_requests=5000` 控制资源消耗。

#### uvicorn 配置 (第 237–244 行)

```python
uvicorn.run(app, host="0.0.0.0", port=8765, log_level="warning",
    timeout_keep_alive=30,      # HTTP 连接 30 秒空闲后关闭
    limit_concurrency=50,        # 并发连接上限
    limit_max_requests=5000,    # 处理 5000 个请求后重启 worker (防止内存泄漏)
)
```

---

## 5. React 前端核心

### 5.1 `frontend/index.html` (20 行) — HTML 入口

```html
<html lang="zh-CN">
  <head>
    <meta name="theme-color" content="#0a0a0a" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <!-- Google Fonts 预加载 8 种中文字体 -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=..." rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

预加载的 8 种字体：Noto Sans SC, Noto Serif SC, ZCOOL KuaiLe, ZCOOL XiaoWei, Ma Shan Zheng, Zhi Mang Xing, Liu Jian Mao Cao, Long Cang。

### 5.2 `frontend/src/main.tsx` (10 行) — React 入口

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>
);
```

### 5.3 `frontend/src/types.ts` (46 行) — TypeScript 类型

与后端 Pydantic 模型一一对应，但前端版本不包含 `file_path` 和 `lrc_path`（安全考虑）。

额外定义：
- `SearchResult: { total: number; songs: Song[] }` — 分页搜索响应
- `PlayerState` — 播放器全局状态 (currentSong, playlist, isPlaying, currentTime, duration, volume, playMode, lastSongId)

### 5.4 `frontend/src/api.ts` (42 行) — API 客户端

使用相对路径（不写 `http://localhost:8765`），因为 Vite 开发服务器有 proxy 配置，生产环境前后端同域。

```typescript
const BASE = '';  // 相对路径，靠 Vite proxy 转发

export const api = {
  getStatus:     () => fetchJSON<...>(`/api/status`),
  getArtists:    () => fetchJSON<...>(`/api/artists`),
  getSongs:      (search, limit, offset) => fetchJSON<...>(`/api/songs?...`),
  getSong:       (id) => fetchJSON<...>(`/api/songs/${id}`),
  getLyrics:     (id) => fetchJSON<...>(`/api/lyrics/${id}`),
  streamUrl:     (id) => `/api/stream/${id}`,       // 直接返回 URL 给 <audio>
  coverUrl:      (id, size) => `/api/cover/${id}?size=${size}`,  // 返回 URL 给 <img>
  refreshSongs:  () => fetch(`/api/refresh`, { method: 'POST' }),
};
```

关键：`streamUrl` 和 `coverUrl` 不发起请求，只返回 URL 字符串，由 `<audio>` 和 `<img>` 标签自行加载。

### 5.5 `frontend/src/App.tsx` (83 行) — 主应用

#### `BackgroundInit` 组件 (第 16–38 行)
启动时立即从 localStorage 读取用户保存的背景和亮度设置，应用到三个区域。这是非视觉组件，render 返回 `null`。

#### `applyBgStyle()` 函数 (第 40–55 行)
动态创建 `<style>` 标签注入 CSS，不依赖 React 渲染：
```typescript
const id = `bg-${area}-style`;
let el = document.getElementById(id);
if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
el.textContent = `${selector} { background-image: url('${url}') !important; filter: brightness(${brightness}) ...; }`;
```
- `main` 区域：修改 `body::before` 伪元素
- `sidebar` 区域：修改 `.sidebar-bg` 类 + 保持 `::before` 遮罩
- `player` 区域：修改 `.player-bg` 类

#### 路由结构

```
/ → AllSongsPage         (全部歌曲 A-Z 分组)
/artists → ArtistsPage   (歌手列表)
/artist/:name → ArtistSongsPage (某歌手的歌曲)
/search → SearchPage     (搜索)
/settings → SettingsPage (设置)
```

#### 布局结构

```
<TitleBar />                    ← 仅在 Electron 环境显示
<div flex>
  <Sidebar />                   ← 左侧导航
  <main><Routes>...</Routes></main>
</div>
<PlayerBar />                   ← 底部固定播放栏
```

### 5.6 `frontend/src/store.tsx` (347 行) — 全局播放器状态管理

这是前端最核心的文件，使用 `useReducer` + `Context` 管理整个播放器状态。

#### 高频值 Ref (第 23–24 行)

```typescript
export const timeRef = { current: 0 };
export const durRef = { current: 0 };
```

为什么用 Ref 而不是 State？
- `timeupdate` 事件每秒触发约 4 次
- 如果每次都用 `dispatch(SET_TIME)` 更新 state → 触发 React 全树重渲染 → 676 行列表项全部 VDOM diff
- Ref 更新不触发渲染，但可以被 PiP tick 和歌词滚动直接读取
- State 只每 500ms 更新一次（节流），用于进度条显示

#### Action 类型 (第 8–20 行)

```
SET_SONG, PLAY, PAUSE, TOGGLE_PLAY, SET_TIME, SET_DURATION,
SET_VOLUME, TOGGLE_MUTE, SET_PLAYLIST, NEXT, PREV, SET_MODE
```

#### 持久化加载 (第 27–39 行)

```typescript
function loadPersistedState() {
  const saved = localStorage.getItem('haizhe-player');
  // 读取 playMode 和 lastSongId
}
```

#### Reducer 关键逻辑

**NEXT** (第 83–94 行)：
```typescript
// 顺序/循环：idx = (idx + 1) % length
// shuffle：随机索引
const nextIdx = state.playMode === 'shuffle'
  ? Math.floor(Math.random() * state.playlist.length)
  : (idx + 1) % state.playlist.length;
```

**PREV** (第 95–104 行)：
```typescript
const prevIdx = (idx - 1 + state.playlist.length) % state.playlist.length;
```

**SET_PLAYLIST** (第 73–80 行)：同时设置 currentSong（通过 startIndex），暂停播放。

#### 核心 Effects 详解

**1. 冷启动预热** (第 145–166 行)：
```typescript
const warmup = async () => {
  const { songs } = await api.getSongs('', 1);   // 取第一首歌
  const audio = new Audio();
  audio.volume = 0; audio.muted = true;           // 静音
  audio.src = api.streamUrl(songs[0].id);
  audio.load();
  await new Promise((resolve) => {
    audio.addEventListener('canplay', resolve, { once: true });
    setTimeout(resolve, 3000);                     // 3 秒超时
  });
  audio.remove(); audio.src = '';                  // 释放
};
```
- 创建临时隐藏音频元素，加载第一首歌到 `canplay` 状态
- 预热浏览器的音频解码管线 (MediaSource、codec 初始化)
- 使首次点击播放无延迟，避免 20 秒卡顿

**2. Time update 节流** (第 128–136 行)：
```typescript
const handleTimeUpdate = (e) => {
  const t = e.currentTarget.currentTime;
  timeRef.current = t;                    // 实时更新 Ref
  const now = performance.now();
  if (now - lastTimeDispatch.current >= 500) {  // 仅 500ms 一次
    lastTimeDispatch.current = now;
    dispatch({ type: 'SET_TIME', time: t });     // 更新 State → 进度条重渲染
  }
};
```

**3. 歌曲切换** (第 169–180 行)：
```typescript
audio.pause();
audio.src = '';                            // ← 关键：释放旧解码缓冲
audio.src = api.streamUrl(state.currentSong.id);
if (state.isPlaying) audio.play();
```
`audio.src = ''` 是 Chromium 规范中触发媒体资源释放的标准方式。如果跳过这一步直接设新 URL，旧 MP3 的解码缓冲不会被 GC 回收，导致内存持续上涨。

**4. Play/Pause 同步** (第 186–224 行)：
- 使用 `canplayHandlerRef` 追踪 canplay 监听器的引用
- 播放前检查 `audio.readyState >= HAVE_FUTURE_DATA`
- 如果数据未就绪，注册 `canplay` 事件等待
- cleanup 中移除残留监听器，防止内存泄漏

**5. 播放结束处理** (第 278–291 行)：
```typescript
const handleEnded = () => {
  if (state.playMode === 'repeat-one') {
    audio.currentTime = 0; audio.play();   // 单曲循环：回到开头重播
  } else {
    dispatch({ type: 'NEXT' });            // 其他模式：下一首
  }
};
```

**6. 错误容错** (第 294–307 行)：
```typescript
const handleError = () => {
  if (err.code === MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === MEDIA_ERR_NETWORK) {
    dispatch({ type: 'NEXT' });  // 文件被删：自动跳到下一首
  }
};
```

**7. 启动恢复** (第 251–275 行)：
```typescript
// 2 秒后从后端取上次播放的歌
const restore = async () => {
  const [song, songList] = await Promise.all([
    api.getSong(lastId),
    api.getSongs('', 1000),        // 同时取全部列表，确保上下曲可用
  ]);
  const idx = songList.songs.findIndex(s => s.id === song.id);
  dispatch({ type: 'SET_PLAYLIST', playlist: songList.songs, startIndex: idx });
};
// 歌曲已被删除 → 清除记忆
```

**8. Context 稳定性** (第 326 行)：
```typescript
const ctxValue = useMemo(() => ({ state, dispatch, audioRef, play, playArtist }),
  [state, dispatch, play, playArtist]);
```
`useMemo` 确保每次渲染 Context value 是同一个引用（除非依赖变化），避免消费者组件全量重渲染。

#### `usePlayer()` Hook (第 343–347 行)

```typescript
export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
```

### 5.7 `frontend/src/index.css` (163 行) — 全局样式

#### CSS 变量体系 (第 4–24 行)

```css
:root {
  --bg-primary: #0a0a12;       /* 最深背景 */
  --bg-secondary: #12121f;     /* 次级背景 */
  --bg-surface: #1a1a2e;       /* 卡片表面 */
  --bg-hover: #252540;         /* 悬停高亮 */
  --accent: #ff6b8a;           /* 主题粉 */
  --accent-dim: #c0396b;
  --accent-glow: rgba(255,107,138,0.3);
  --text-primary: #f0f0f5;
  --text-secondary: #9d9db5;
  --text-tertiary: #5c5c7a;
  --glass-bg: rgba(18,18,31,0.65);  /* 毛玻璃背景 */
  --glass-border: rgba(255,255,255,0.06);
  --font-ui: 'Noto Sans SC', ...;      /* 可切换 */
  --font-lyrics: 'Noto Serif SC', ...;
  --font-heading: 'Noto Sans SC', ...;
}
```

#### 三区域背景系统 (第 37–96 行)

```
body::before   — 主页面背景 (bg-main.png), brightness(0.3)
body::after    — 星空效果 (19 个 radial-gradient 模拟星星 + twinkle 动画)
.sidebar-bg    — 侧边栏背景 + ::before 遮罩 rgba(10,10,25,0.55) + blur(8px)
.player-bg     — 全屏播放页背景
```

星空动画：
```css
@keyframes twinkle {
  0% { opacity: .6; }
  50% { opacity: .9; }
  100% { opacity: .5; }
}
```

#### 毛玻璃效果 (第 107–118 行)

```css
.glass {
  background: rgba(18, 18, 31, 0.4);
  backdrop-filter: blur(30px);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.glass-light {
  background: rgba(30, 30, 50, 0.45);
  backdrop-filter: blur(20px);
}
```

#### 进度条 (第 131–141 行)

```css
input[type="range"].progress-bar {
  height: 4px;
  /* 填充效果通过 inline style 的 linear-gradient 实现 */
}
.progress-bar::-webkit-slider-thumb {
  width: 14px; height: 14px;
  border-radius: 50%;
  opacity: 0;              /* 默认隐藏滑块 */
  transition: opacity 0.2s;
}
.progress-bar:hover::-webkit-slider-thumb { opacity: 1; }  /* hover 才显示 */
```

#### 歌词行 (第 143–156 行)

```css
.lyrics-line.active {
  color: #fff;
  font-weight: 600;
  font-size: 1.15em;       /* 当前行放大 15% */
  text-shadow: 0 0 20px rgba(255,107,138,0.6);  /* 粉色发光 */
}
.lyrics-line.inactive {
  color: rgba(255,255,255,0.22);  /* 非当前行暗淡 */
}
```

#### 骨架屏 (第 158–163 行)

```css
.skeleton {
  background: linear-gradient(90deg, var(--bg-surface), var(--bg-hover), var(--bg-surface));
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;  /* 流光动画 */
}
```

---

## 6. 前端组件

### 6.1 `Sidebar.tsx` (166 行) — 侧边栏导航

#### `Sidebar` 组件
- 宽度 240px，小屏 (max-lg) 缩到 64px (仅图标)
- Logo 区域使用 `text-gradient` CSS 类 (粉橙渐变文字)
- 4 个 `NavLink`，React Router 自动高亮当前激活项
- 底部装饰区：SVG 音符波浪曲线 + 音符字符，小屏隐藏

#### `CoverThumbnail` 组件 (第 114–166 行) — 可复用封面缩略图

三种状态管理：
```typescript
const [imgState, setImgState] = useState<'loading' | 'ok' | 'error'>('loading');
```

**songId 变化时**：重置为 `loading`，触发 `<img src={newUrl}>` 重新加载。

**卸载时清理** (第 125–127 行)：
```typescript
useEffect(() => {
  return () => { if (imgRef.current) imgRef.current.src = ''; };
}, []);  // 注意：空依赖，仅组件卸载时执行
```
⚠️ **重要设计决策**：不在 songId 变化 cleanup 中清空 src。原因是 React 的 cleanup 在 render 之后执行，如果 cleanup 中 `src=''`，会把 render 刚设好的新 URL 也清掉，导致永久白屏。

**eager 模式** (播放栏使用)：
- `loading="eager"` + `fetchpriority="high"` 优先级加载
- 监听 `visibilitychange`：窗口从最小化恢复时，GPU 可能已丢弃解码位图 → 强制重载 (`forceReload + 1`)

**普通模式** (列表项使用)：
- `loading="lazy"` — 676 张封面不会同时加载，只加载可视区域内的

### 6.2 `PlayerBar.tsx` (383 行) — 播放栏 + 全屏 + 桌面歌词

最复杂的组件，包含三个子模块。

#### 6.2.1 桌面歌词系统

**网页版 — Document PiP** (第 50–78 行)：

```typescript
async function pipOpen(): Promise<Window | null> {
  pipWin = await documentPictureInPicture.requestWindow({ width: 420, height: 100 });
  doc.body.style.cssText = pipStyles(cfg);
  doc.body.textContent = '♫ 等待歌词...';
}
```

- 使用 Chrome 116+ 的 `documentPictureInPicture` API
- 420×100 独立小窗口
- 读取 localStorage 中的配置生成内联样式

**Electron 版 — 透明窗口**：
通过 `window.electronAPI.lyricUpdate()` 和 `lyricConfig()` 发 IPC 到主进程，主进程转发到 `lyrics.html` 独立窗口。

**tick 循环** (第 103–140 行) — 两种模式的统一更新：

```typescript
// 400ms 间隔
const tick = async () => {
  const idx = lyricsCache.lines.findLastIndex(l => l.time <= timeRef.current);
  const cur = lyricsCache?.lines[idx] || null;
  const nxt = lyricsCache && idx >= 0 ? lyricsCache.lines[idx + 1] : null;

  if (isElectron) {
    electronAPI.lyricUpdate({ text: cur?.text || '♪', next: nxt?.text || '' });
    // 配置变化检测：JSON 序列化比对 → 仅在变化时才发 IPC
    const cfgStr = JSON.stringify(readPipCfg());
    if (cfgStr !== cachedCfg) {
      electronAPI.lyricConfig(readPipCfg());
    }
  } else {
    pipUpdate(cur?.text || '♪', nxt?.text);
  }
};
```

- `findLastIndex` 查找最后一个时间 ≤ 当前播放时间的歌词行
- 通过 `timeRef.current` 读取实时时间（跳过 React 渲染链路）
- 依赖只有 `[pipOn, songId]`，不依赖 `currentTime`（否则每 500ms 重建 interval）
- 配置变化通过缓存比对避免无效 IPC 消息

#### 6.2.2 底部播放栏 (第 205–261 行)

布局：`封面(42px) | 歌曲信息 | 播放控制 | 时间 | 音量`

关键细节：
- 进度条在播放栏**顶部**，用 `translate-y-1/2` 半浮在播放栏上沿
- 进度条填充用 inline `linear-gradient` 计算：`linear-gradient(to right, accent ${pct}%, transparent ${pct}%)`
- "词" 按钮 → 打开全屏播放页
- "桌词" 按钮 → 切换 PiP/Electron 桌面歌词

#### 6.2.3 `FSPlayer` 全屏播放组件 (第 266–383 行)

```tsx
<FSPlayer key={currentSong.id} ... />
```

⚠️ **`key={currentSong.id}`** — 切歌时强制卸载重建整个 `FSPlayer`，确保封面 `<img>` 元素被彻底销毁并释放 GPU 纹理。

左半部分：
- 封面 (800px 原图) + 歌曲名 + 歌手
- 封面 `ref` + cleanup 中 `src=''` 确保卸载时释放解码位图
- Error 时：隐藏 img + 显示粉紫渐变背景

右半部分：
- 歌词区域，自动居中滚动当前行
- 用户手动滚动 → `userScroll.current = true` → 3 秒后恢复自动
- 点击歌词行 → 跳转到对应时间点

底部：
- 进度条 + 时间 + 播放控制 + 音量

### 6.3 `TitleBar.tsx` (39 行) — 自定义标题栏

仅在 `window.electronAPI` 存在时渲染（Electron 环境）。

```tsx
// 拖拽区域
<div style={{ WebkitAppRegion: 'drag' }}>
// 按钮（不可拖拽）
<div style={{ WebkitAppRegion: 'no-drag' }}>
```

三个按钮：最小化 / 最大化 / 关闭。关闭按钮 hover 时红色背景。

### 6.4 `FloatingLyrics.tsx` (64 行) — 页面内歌词悬浮窗

已弃用，保留备用。在页面内显示类似桌面歌词的悬浮条，使用 `timeRef` 同步歌词，毛玻璃背景。

---

## 7. 前端页面

### 7.1 `AllSongsPage.tsx` (189 行) — 全部歌曲 (A-Z 分组)

#### 性能优化架构

```
AllSongsPage (memo)
├── 标题栏 (memo 隔离)
└── SongListContent (独立 memo)    ← 关键：不随 timeupdate 重渲染
    └── SongRow × N (memo)          ← 仅 song.id 变化才重渲染
```

**为什么这样拆分？**

`store.tsx` 的 `SET_TIME` 每 500ms dispatch 一次，更新 `state.currentTime`。如果 `AllSongsPage` 读取了 `state.currentTime`，它会在每次 timeupdate 时重渲染。拆分后：

- `AllSongsPage` — 不读 `currentTime`，读写 `state.currentSong?.id` 和 `state.isPlaying`
- `SongListContent` — 接收 `currentSongId` 和 `isPlaying`（稳定 props），不读 `currentTime`
- `SongRow` — 接收 `isCurrent` 和 `isPlaying`，`memo` 只在 props 变化时重渲染
- 结果：676 行列表在 timeupdate 时完全跳过 VDOM diff

#### A-Z 分组逻辑 (第 25–42 行)

```typescript
const grouped = useMemo(() => {
  const g: Record<string, Song[]> = {};
  for (const s of songs) {
    const first = s.title.charAt(0).toUpperCase();
    const letter = /^[A-Z]$/.test(first) ? first : '#';  // 非字母归入 #
    g[letter].push(s);
  }
  return g;
}, [songs]);

const letters = useMemo(() =>
  Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1;    // # 组排最后
    if (b === '#') return -1;
    return a.localeCompare(b);
  })
, [grouped]);
```

#### SongRow 均衡器动画 (第 85–90 行)

```html
<div className="flex items-center gap-[2px] h-4">
  <span className="animate-[eq_0.5s_infinite]" style="height:8px; animationDelay:0s" />
  <span className="animate-[eq_0.5s_infinite]" style="height:14px; animationDelay:0.15s" />
  <span className="animate-[eq_0.5s_infinite]" style="height:5px; animationDelay:0.3s" />
</div>

/* CSS */
@keyframes eq { 0%,100% { height:4px } 50% { height:16px } }
```
三根柱子弹跳动画，模拟均衡器效果，仅对当前播放行显示。

#### 刷新功能 (第 133–141 行)

```typescript
const handleRefresh = async () => {
  await api.refreshSongs();    // POST /api/refresh → 重新扫描
  const r = await api.getSongs('', 1000);  // 拉取最新数据
  setSongs(r.songs);
};
```

#### 加载重试 (第 114–126 行)

```typescript
for (let retry = 0; retry < 10; retry++) {
  try {
    const r = await api.getSongs('', 1000);
    setSongs(r.songs); return;
  } catch {
    await new Promise(r => setTimeout(r, 500));  // 500ms 间隔重试
  }
}
```
后端启动需要时间，前 10 次请求（最长 5 秒）自动重试。

### 7.2 `ArtistsPage.tsx` (111 行) — 歌手列表

- 与 AllSongsPage 相同的 A-Z 分组逻辑
- Grid 布局：`grid-cols-2` 到 `grid-cols-5` 响应式
- 每项：圆形头像 (封面图 / 首字母 fallback) + 歌手名 + 歌曲数
- 点击跳转到 `/artist/:name` 路由

### 7.3 `ArtistSongsPage.tsx` (101 行) — 歌手歌曲列表

- URL 参数 `:name` 决定显示哪个歌手
- Banner：紫黑渐变 + 歌手名 + 歌曲数
- 歌曲列表：复用与 AllSongsPage 相同的 `SongRow` 风格（内联实现）
- 均衡器动画 + framer-motion 入场动画

### 7.4 `SearchPage.tsx` (155 行) — 搜索页

**URL 参数驱动**：
```typescript
const [searchParams, setSearchParams] = useSearchParams();
const query = searchParams.get('q') || '';
```
搜索关键词写入 URL 的 `?q=` 参数，支持浏览器前进/后退和书签。

**三种空状态**：
1. 未搜索 → 搜索图标 + "输入关键词搜索"
2. 搜不到 → "未找到相关歌曲" + "试试其他关键词"
3. 加载中 → 骨架屏 (6 行)

**提交逻辑**：`setSearchParams(input ? { q: input } : {})` — 空输入清空参数。

### 7.5 `SettingsPage.tsx` (259 行) — 设置页

三大部分：背景 DIY、字体系统、桌面歌词样式。所有设置通过 `localStorage` 持久化且即时生效。

#### 背景图 DIY (第 126–172 行)

```
三列预览 (main | sidebar | player)：
  - 缩略图预览 (aspect-video)
  - 亮度滑块 (0.1–0.9, step 0.05)
  - 图片选择按钮 (从 /api/bg-images/ 加载列表)
  - 本地上传按钮 (File API + Object URL)
```

`localStorage` 存储：
- `haizhe-bg`: `{ main: "url", sidebar: "url", player: "url" }`
- `haizhe-dim`: `{ main: 0.3, sidebar: 0.55, player: 0.55 }`

`applyBg()` 函数 (第 239–259 行)：直接操作 DOM 创建 `<style>` 标签，绕过 React 渲染。

#### 字体系统 (第 175–181 行)

三类字体独立配置：
- 界面字体 (`--font-ui`) — 按钮、列表、导航
- 标题字体 (`--font-heading`) — 页面标题
- 歌词字体 (`--font-lyrics`) — 播放页 + 悬浮窗

每种字体有 8 个选项，即时更新 CSS 变量 → 全页面字体立即切换。

#### 桌面歌词悬浮窗样式 (第 184–228 行)

- 背景深浅：`rgba(0,0,0,${pipBg})`，范围 0–0.95
- 字体颜色：HTML color picker (`<input type="color">`)
- 字体大小：14–36px
- 实时预览框模拟悬浮窗效果
- 歌词字体跟随 "歌词字体" 配置

#### 恢复默认 (第 87–91 行)

```typescript
const resetAll = () => {
  setBg(DEFAULTS); setDim({ main: 0.3, sidebar: 0.55, player: 0.55 });
  setUiFont('noto-sans'); setLyricsFont('noto-serif'); setHeadingFont('noto-sans');
  localStorage.clear();  // 清除所有 localStorage 数据
};
```

---

## 8. 全局样式系统

`index.css` (详见 5.7 节) 是整个应用视觉风格的基石。核心设计原则：

1. **CSS 变量集中管理** — 任何颜色/间距/字体变化只需修改变量值
2. **三区域独立背景** — main/sidebar/player 各自独立背景图和亮度
3. **毛玻璃效果** — `.glass` 和 `.glass-light` 提供统一的半透明模糊面板
4. **组件样式极简** — Tailwind 负责布局/间距/颜色，自定义 CSS 只覆盖 Tailwind 做不到的部分（进度条滑块、歌词行发光、背景层叠加）

---

## 9. 构建与打包配置

### 9.1 `package.json`

```json
{
  "name": "haizhe-music",
  "main": "electron/main.js",
  "scripts": {
    "dev": "electron .",
    "start": "electron .",
    "build:frontend": "cd frontend && npm run build"
  },
  "devDependencies": {
    "electron": "^42.2.0",
    "electron-builder": "^26.8.1"
  }
}
```

### 9.2 `electron-builder.yml`

```yaml
appId: com.haizhe.music
productName: HaiZhe Music
directories:
  output: release/

files:
  - electron/**/*
  - frontend/dist/**/*
  - package.json

extraResources:
  - from: backend/
    to: backend/

win:
  target: portable
  icon: electron/cat-icon.ico

portable:
  artifactName: HaiZhe-Music.exe
```

关键配置：
- `portable` 目标 → 输出单个 `.exe` (非安装包)
- `extraResources` → 将 Python 后端目录复制到 `resources/backend/`
- 打包时前端必须预先构建 (`frontend/dist/`)

### 9.3 `frontend/vite.config.ts`

```typescript
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:8765',   // 前端请求 /api/* 自动转发到后端
    },
  },
});
```

### 9.4 `frontend/tsconfig.app.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

---

## 10. 数据流全景

### 10.1 启动数据流

```
双击 start-desktop.bat
  → Electron app.whenReady()
  → spawn python main.py (端口 8765)
  → spawn npx vite (端口 5173)
  → 轮询等待两个端口就绪
  → createMainWindow → loadURL(5173)
  → React 挂载
    → BackgroundInit: 从 localStorage 读取背景/字体 → 注入 CSS
    → PlayerProvider 挂载
      → 冷启动预热: 创建隐藏 <audio> 加载第一首到 canplay
      → 2 秒后恢复上次播放: api.getSong(lastId) + api.getSongs → SET_PLAYLIST
    → AllSongsPage 加载歌曲列表
    → Sidebar / PlayerBar 渲染
```

### 10.2 播放数据流

```
用户点击歌曲 → play(song, playlist)
  → dispatch SET_PLAYLIST → reducer 更新 state
  → useEffect([songId]):
    audio.src = ''           ← 释放旧缓冲
    audio.src = streamUrl    ← 设置新流
    canplay → audio.play()
  → timeupdate (约 4 次/秒):
    timeRef.current = t           ← 实时更新 (零渲染开销)
    每 500ms: dispatch SET_TIME  ← 进度条更新
  → PiP/歌词 tick (400ms):
    findLastIndex(l.time <= timeRef.current)  ← 从 Ref 读取
    → 更新桌面歌词 / PiP 窗口

播放结束 (ended):
  repeat-one → currentTime=0 重播
  其他模式 → dispatch NEXT
```

### 10.3 封面加载数据流

```
启动扫描 (scanner.py):
  → 遍历 MP3 → ID3 APIC → PIL 缩放 150px → JPEG 存盘

列表渲染 (CoverThumbnail):
  → <img src="/api/cover/{id}?size=150" loading="lazy">
  → 请求到达后端 → FileResponse(cache/{id}.jpg) → < 5ms

全屏播放 (FSPlayer):
  → <img src="/api/cover/{id}?size=800">
  → 请求到达后端 → _extract_raw_cover() 从 ID3 提取原图
  → 切歌: key={songId} 强制卸载 → cleanup 中 img.src = '' → 释放 GPU 纹理
```

### 10.4 设置数据流

```
用户修改背景/字体/歌词样式
  → React state 更新 → 即时生效（CSS 变量 / DOM style 标签）
  → 同步写入 localStorage
  → PiP 配置：tick 循环下次检测到变化 → 发 IPC 更新

用户重新打开应用
  → BackgroundInit 读 localStorage → 注入 CSS → 上次的背景还在
  → PlayerProvider 读 localStorage → 恢复音量和播放模式
  → 2 秒后恢复上次播放的歌
```

---

## 11. 内存管理策略

这是 V8-V10 迭代中最重要的技术累积。

### 问题 → 根因 → 修复

| 版本 | 现象 | 根因 | 修复方案 | 文件位置 |
|------|------|------|----------|----------|
| V8 | 听 1 小时内存 → 2GB+ | 676 张 1000×1000 封面全量解码到 GPU | 150px 磁盘缓存 + `loading="lazy"` | `scanner.py` _save_thumbnail, `main.py` get_cover |
| V9 | 切歌内存持续上涨 | `removeAttribute('src')` 不释放音频缓冲 | `audio.src = ''` 触发 Chromium media resource abort | `store.tsx` 第 174–176 行 |
| V10 | 全屏"词"缓慢泄漏 | 原图无释放机制 | `key={songId}` 强制卸载 + cleanup `src=''` | `PlayerBar.tsx` 第 191, 303 行 |
| V10 | `key` on `<img>` 反而爆内存 | React key 变化触发重新解码管线 | 改用 `ref` + cleanup 中 `src=''` | `FSPlayer` coverRef |
| V10.1 | 676 行列表每 500ms 重渲染 | timeupdate → dispatch → 全量 VDOM diff | `SongListContent` memo 隔离 + `timeRef` 跳过渲染链路 | `store.tsx` timeRef, `AllSongsPage.tsx` SongListContent |

### 三重 GC 机制

| 层级 | 机制 | 触发 |
|------|------|------|
| **Chromium JS** | `--expose-gc` + `window.gc()` | 每 3 分钟，仅窗口未聚焦时 | `electron/main.js` 第 107–116 行 |
| **Chromium 图片** | `img.src = ''` + `loading="lazy"` + `key={id}` 卸载 | 切歌 / 组件卸载时 | `Sidebar.tsx` CoverThumbnail, `PlayerBar.tsx` FSPlayer |
| **Python** | `gc.collect()` | 异步任务每 5 分钟 | `main.py` 第 225–234 行 |

### 最终内存基线

```
空闲状态: ~500MB
播放中: ~500-800MB (根据封面数量波动)
长时间播放: 不再单边上涨
```

---

## 附录 A：文件行数统计

| 文件 | 行数 | 职责 |
|------|------|------|
| `backend/main.py` | 244 | FastAPI 服务 + 所有 API 端点 |
| `backend/scanner.py` | 189 | MP3 扫描 + ID3 解析 + 封面缓存 |
| `backend/lyrics.py` | 55 | LRC 解析 |
| `backend/models.py` | 33 | 数据模型 |
| `electron/main.js` | 204 | Electron 主进程 |
| `electron/preload.js` | 19 | IPC 桥接 |
| `electron/lyrics.html` | 62 | 桌面歌词窗口 |
| `frontend/src/store.tsx` | 347 | 播放器状态管理 |
| `frontend/src/components/PlayerBar.tsx` | 383 | 播放栏 + 全屏 + 桌面歌词 |
| `frontend/src/pages/SettingsPage.tsx` | 259 | 设置页 |
| `frontend/src/pages/AllSongsPage.tsx` | 189 | 全部歌曲 A-Z |
| `frontend/src/components/Sidebar.tsx` | 166 | 侧边栏 + 封面缩略图 |
| `frontend/src/index.css` | 163 | 全局样式 |
| `frontend/src/pages/SearchPage.tsx` | 155 | 搜索页 |
| `frontend/src/pages/ArtistsPage.tsx` | 111 | 歌手列表 |
| `frontend/src/pages/ArtistSongsPage.tsx` | 101 | 歌手歌曲 |
| `frontend/src/App.tsx` | 83 | 主应用 + 路由 + 布局 |
| `frontend/src/components/FloatingLyrics.tsx` | 64 | 歌词悬浮窗 |
| `frontend/src/types.ts` | 46 | TS 类型 |
| `frontend/src/api.ts` | 42 | API 客户端 |
| `frontend/src/components/TitleBar.tsx` | 39 | 标题栏 |
| `frontend/src/main.tsx` | 10 | 入口 |

---

## 附录 B：关键设计决策速查

| 决策 | 原因 |
|------|------|
| 后端用 Python 而非 Node | mutagen 是 Python 最成熟的 MP3/ID3 库 |
| `useReducer` 而非 Redux/Zustand | 项目规模适中，原生方案无额外依赖 |
| `timeRef` 高频值用 Ref 而非 State | 避免 timeupdate 触发 676 行列表全量重渲染 |
| 封面 150px 磁盘缓存 | 676 张原图会占 2.7GB GPU 内存 |
| `audio.src = ''` 切歌 | Chromium 唯一标准触发媒体资源释放的方式 |
| `key={songId}` 全屏播放 | 强制重建组件，确保旧封面 img 被销毁 |
| PC 宽度 240px / 移动端 64px | 响应式设计，手机竖屏也能用 |
| Document PiP + Electron 窗口双轨 | 浏览器端用 PiP API，Electron 端用原生透明窗口 |
| localStorage 持久化 | 无后端数据库，用户设置直接存浏览器本地 |
| Vite proxy `/api` → 8765 | 开发和生产同路径，无需写绝对 URL |
| `limit_max_requests=5000` | uvicorn worker 处理一定量请求后自动重启，防止微小内存泄漏累积 |

---

*Made in China, Nan*
*最后更新: 2026-06-06*
