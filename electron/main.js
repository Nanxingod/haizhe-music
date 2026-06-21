// Electron 主进程 - 海蜇音乐桌面版（V9 内存优化版）
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

// ⚡ 启用 Chromium 手动 GC（配合闲置 GC timer 释放 JS 堆碎片）
// 注：GPU/图片内存靠后端封面缩放控制，不在此限制范围内
app.commandLine.appendSwitch('js-flags', '--expose-gc');

let mainWin = null;
let lyricWin = null;
let lyricReady = false;
let pendingLyricCfg = null; // 歌词窗口就绪前暂存配置
let backendProc = null;
let frontendProc = null;

// ── 启动后端 ──
function startBackend() {
  const isDev = !app.isPackaged;
  const backendDir = isDev
    ? path.join(__dirname, '..', 'backend')
    : path.join(process.resourcesPath, 'backend');
  backendProc = spawn('python', ['main.py'], {
    cwd: backendDir, stdio: 'ignore', windowsHide: true, shell: true,
  });
  backendProc.on('error', (err) => console.error('[Backend] 启动失败:', err.message));
  // V10.3: 记录后端退出信息（崩溃/被杀时能排查原因）
  backendProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`[Backend] 异常退出: code=${code}`);
    if (signal) console.error(`[Backend] 被信号终止: ${signal}`);
  });
}

// ── 启动前端（Vite） ──
function startFrontend() {
  const frontendDir = path.join(__dirname, '..', 'frontend');
  frontendProc = spawn('npx', ['vite', '--host', '0.0.0.0'], {
    cwd: frontendDir, stdio: 'ignore', windowsHide: true, shell: true,
  });
  frontendProc.on('error', (err) => console.error('[Frontend] 启动失败:', err.message));
  frontendProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`[Frontend] 异常退出: code=${code}`);
    if (signal) console.error(`[Frontend] 被信号终止: ${signal}`);
  });
}

// ── 清理所有子进程 ──
function cleanup() {
  if (backendProc) {
    try {
      // 先温柔关闭（SIGTERM on win = terminate），再强制杀
      if (!backendProc.killed) {
        backendProc.kill('SIGTERM');
        setTimeout(() => {
          if (backendProc && !backendProc.killed) backendProc.kill('SIGKILL');
        }, 3000);
      }
    } catch {}
    backendProc = null;
  }
  if (frontendProc) {
    try {
      if (!frontendProc.killed) {
        frontendProc.kill('SIGTERM');
        setTimeout(() => {
          if (frontendProc && !frontendProc.killed) frontendProc.kill('SIGKILL');
        }, 3000);
      }
    } catch {}
    frontendProc = null;
  }
  if (lyricWin && !lyricWin.isDestroyed()) { lyricWin.close(); lyricWin = null; }
}

// ── 轮询等待 URL 就绪 ──
function waitForUrl(url, timeoutMs = 30000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for ${url}`));
        } else {
          setTimeout(tryConnect, intervalMs);
        }
      });
      req.end();
    };
    tryConnect();
  });
}

// ── 主窗口 ──
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 800, minHeight: 600,
    frame: false,
    backgroundColor: '#0a0a12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // ⚡ 内存优化：限制后台页面资源占用
      backgroundThrottling: true,
    },
    show: false, // 等加载完再显示，避免白屏闪烁
  });

  // ⚡ 闲置内存回收：每 3 分钟触发 Chromium GC，释放图片缓冲和 JS 堆
  const gcInterval = setInterval(() => {
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isFocused()) {
      mainWin.webContents.executeJavaScript('window.gc && window.gc()').catch(() => {});
    }
  }, 180000); // 每 3 分钟，且仅当窗口未聚焦时（不影响用户体验）

  mainWin.on('closed', () => {
    clearInterval(gcInterval);
    mainWin = null;
  });

  const isDev = !app.isPackaged;
  const url = isDev ? 'http://localhost:5173' : null;

  if (isDev) {
    mainWin.loadURL(url);
  } else {
    mainWin.loadFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
  }

  // 页面加载完成后显示窗口
  mainWin.once('ready-to-show', () => {
    mainWin.show();
  });
}

// ── 桌面歌词窗口 ──
function createLyricWindow() {
  lyricReady = false;
  lyricWin = new BrowserWindow({
    width: 500, height: 80,
    x: 100, y: 100,
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  lyricWin.loadFile(path.join(__dirname, 'lyrics.html'));
  lyricWin.setAlwaysOnTop(true, 'screen-saver');
  lyricWin.webContents.on('did-finish-load', () => {
    lyricReady = true;
    // 如果窗口加载期间有配置到达，现在应用它
    if (lyricWin && !lyricWin.isDestroyed()) {
      lyricWin.webContents.send('lyric-config', pendingLyricCfg || {});
    }
    pendingLyricCfg = null;
  });
  lyricWin.on('closed', () => { lyricWin = null; lyricReady = false; });
}

// ── IPC ──
ipcMain.on('window-minimize', () => mainWin?.minimize());
ipcMain.on('window-maximize', () => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin?.maximize());
ipcMain.on('window-close', () => mainWin?.close());
ipcMain.on('lyric-show', () => {
  if (!lyricWin || lyricWin.isDestroyed()) createLyricWindow(); else lyricWin.show();
});
ipcMain.on('lyric-hide', () => { if (lyricWin && !lyricWin.isDestroyed()) lyricWin.close(); });
ipcMain.on('lyric-update', (_e, data) => {
  if (lyricWin && !lyricWin.isDestroyed() && lyricReady) lyricWin.webContents.send('lyric-data', data);
});
ipcMain.on('lyric-config', (_e, cfg) => {
  pendingLyricCfg = cfg; // 始终保存最新配置
  if (lyricWin && !lyricWin.isDestroyed() && lyricReady) lyricWin.webContents.send('lyric-config', cfg);
});

// ── 生命周期 ──
app.whenReady().then(async () => {
  startBackend();
  startFrontend();

  const isDev = !app.isPackaged;
  if (isDev) {
    try {
      await waitForUrl('http://localhost:5173', 30000, 500);
      await waitForUrl('http://localhost:8765/api/status', 60000, 1000);
    } catch (err) {
      console.error('[HaiZhe]', err.message);
    }
  }

  createMainWindow();

  // ⚡ 优雅退出：确保子进程被清理
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(); });
  process.on('SIGTERM', () => { cleanup(); process.exit(); });
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', cleanup);
app.on('activate', () => { if (!mainWin) createMainWindow(); });
