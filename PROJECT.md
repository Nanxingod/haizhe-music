# 海蜇音乐播放器 — 项目总结

> 最后更新: 2026-05-23 | 状态: V9 内存优化版

---

## 项目结构

```
D:\agentspace\music-player\
├── start.bat              ← 网页版启动
├── start-desktop.bat      ← 桌面版启动（Electron）
├── setup-first-run.bat     ← 首次安装 Python 依赖
├── create-shortcut.ps1     ← 创建桌面快捷方式
├── electron-builder.yml    ← 打包配置
├── package.json            ← Electron 入口
├── REQUIREMENTS.md         ← 需求文档
│
├── backend/                ← Python FastAPI 后端
│   ├── main.py             ← API 服务（端口 8765）
│   ├── scanner.py          ← 音乐文件扫描（读 config.json 的 music_dir）
│   ├── lyrics.py           ← LRC 歌词解析
│   ├── models.py           ← 数据模型
│   ├── config.json         ← 音乐目录配置 {"music_dir": "D:\\Music\\lxmusic"}
│   └── requirements.txt    ← Python 依赖
│
├── frontend/               ← React + TypeScript 前端
│   ├── src/
│   │   ├── App.tsx               ← 路由 + 布局
│   │   ├── store.tsx             ← 播放器状态管理（含预热逻辑）
│   │   ├── api.ts                ← 后端 API 客户端
│   │   ├── types.ts              ← TypeScript 类型
│   │   ├── index.css             ← 全局样式（三区域背景系统）
│   │   ├── electron.d.ts         ← Electron API 类型声明
│   │   ├── components/
│   │   │   ├── Sidebar.tsx       ← 侧边栏（全部歌曲/歌手/搜索/设置）
│   │   │   ├── PlayerBar.tsx     ← 底部播放栏 + 全屏播放页 + 桌面歌词
│   │   │   ├── TitleBar.tsx      ← Electron 标题栏（最小化/最大化/关闭）
│   │   │   └── FloatingLyrics.tsx← 页面内歌词悬浮窗（已弃用，保留备用）
│   │   └── pages/
│   │       ├── AllSongsPage.tsx    ← 全部歌曲 A-Z 分组
│   │       ├── ArtistsPage.tsx     ← 歌手列表
│   │       ├── ArtistSongsPage.tsx ← 歌手歌曲列表
│   │       ├── SearchPage.tsx      ← 搜索页
│   │       └── SettingsPage.tsx    ← 设置页（背景DIY + 字体DIY + PiP样式）
│   └── public/bg/               ← 背景图文件夹
│       ├── main/      ← 主页面背景
│       ├── sidebar/   ← 侧边栏背景
│       └── player/    ← 全屏播放页背景
│
├── electron/               ← Electron 桌面端
│   ├── main.js             ← 主进程（启动后端/前端，IPC，窗口管理）
│   ├── preload.js          ← IPC 桥接
│   ├── lyrics.html         ← 桌面歌词窗口（透明置顶）
│   ├── cat-icon.ico        ← 应用图标
│   └── app-icon.ico        ← 备用图标
│
└── release/                ← 打包产物
    └── win-unpacked/       ← 便携版（复制整文件夹即用）
        ├── HaiZhe Music.exe
        └── resources/
            ├── app.asar
            └── backend/
```

---

## 核心功能

### 🎵 播放
- MP3 流式播放 + Range 请求（快进快退）
- LRC 歌词同步滚动 + 点击跳转
- 专辑封面提取（MP3 ID3 APIC 内嵌封面）
- 音量记忆（localStorage）
- 播放模式：顺序/随机/循环
- 音频管线预热（首播即开）

### 📂 音乐管理
- 按歌名 A-Z 分组（默认首页）
- 歌手分类（多歌手拆分：`徐良、阿悄` → 徐良 + 阿悄 各自独立）
- 实时搜索（歌名/歌手）
- 音乐路径通过 `config.json` 配置，换电脑改一行即可

### 🎨 界面
- Apple Music 风格暗色主题
- 三区域独立背景图系统（主页面/侧边栏/播放页）
- 8 种中文字体可选（思源黑体/宋体/快乐圆体/小薇体/马山手写等）
- 背景亮度独立调节
- 响应式布局（PC + 手机）
- 自定义标题栏（Electron 桌面版）

### 🪟 桌面歌词
- **网页版**: Chrome Document Picture-in-Picture API（置顶小窗）
- **桌面版**: Electron 透明置顶窗口（无来源标签、完全透明背景）
- 可调节：背景深浅、字体颜色取色器、字体大小
- 设置修改即时生效

### 📱 手机访问
- 同一 WiFi 下通过局域网 IP 访问
- API 使用 Vite 代理，手机端无跨域问题

---

## 启动方式

### 开发/日常使用
```bash
# 方式1: 网页版
双击 start.bat → 浏览器打开 http://localhost:5173

# 方式2: 桌面版（推荐）
双击 start-desktop.bat → Electron 窗口自动打开
桌面快捷方式 "HaiZhe Music" 已创建
```

### 分发给朋友
```
1. 复制 release/win-unpacked/ 整个文件夹
2. 首次运行 setup-first-run.bat（装 fastapi/uvicorn/mutagen 等）
3. 修改 resources/backend/config.json → 设置自己的音乐目录
4. 双击 HaiZhe Music.exe
```

---

## 已知事项

1. **需要 Python 3.9+**：目标电脑需安装 Python（PyInstaller 打包因 Anaconda 兼容问题未成功，后续可换干净环境重试）
2. **桌面歌词需 Chrome 116+**（网页版 PiP 功能）
3. **打包时 winCodeSign 报错**：不影响使用，只是跳过代码签名步骤
4. **启动需等 4-6 秒**：后端扫描 676 首 mp3 读取 ID3 标签

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python FastAPI + mutagen + uvicorn |
| 前端 | React 18 + TypeScript + Tailwind CSS + Framer Motion |
| 桌面 | Electron 42 + Document PiP API |
| 打包 | electron-builder (portable) |
| 字体 | Google Fonts (Noto Sans/ZCOOL/Ma Shan Zheng 等) |

---

## V9 更新 (2026-05-23): 内存泄漏修复

### 修复的问题
1. **闲置卡死**：`AllSongsPage` 一次性请求 676 张封面 → 添加 `loading="lazy"` + 后端 LRU 缓存上限
2. **播放 CPU/内存渐变上升**：
   - Python 后端 `_cover_cache` 无上限 → 改为 OrderedDict LRU，上限 100MB/200 张
   - `store.tsx` canplay 监听器未清理 → 添加 ref 追踪 + cleanup 确保移除
   - 切歌时旧 audio 资源未回收 → `removeAttribute('src')` + `load()` 强制释放
3. **Chromium 堆膨胀** → Electron main.js 添加 `--expose-gc --max-old-space-size=512` flag
   - 窗口未聚焦时每 3 分钟触发 `window.gc()`
4. **Python uvicorn 连接堆积** → 设置 `timeout_keep_alive=30` + `limit_max_requests=5000`
   - 每 5 分钟自动 `gc.collect()` 回收碎片

### 改动的文件
- `backend/main.py`：LRU 缓存 + GC + uvicorn 参数
- `frontend/src/store.tsx`：canplay 清理 + audio 资源释放
- `frontend/src/components/Sidebar.tsx`：`CoverThumbnail` 加 `loading="lazy"`
- `frontend/src/components/PlayerBar.tsx`：全屏封面加 `loading="lazy"`
- `electron/main.js`：Chromium GC flag + 定期 GC + 子进程清理增强

## 后续可做

- [ ] PyInstaller 干净环境编译 → 免 Python 的独立 exe
- [ ] 桌面歌词锁定/解锁功能
- [ ] 系统托盘最小化
- [ ] 云存储支持
- [ ] 手机端 PWA 安装
