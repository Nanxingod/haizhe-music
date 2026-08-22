// Electron 主进程 - 海蜇音乐桌面版（V11 桌面体验优化版）
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_ID = 'com.haizhe.music';
const PORTS = [8765, 5173]; // 后端 / Vite

// Windows 任务栏身份：与 electron-builder 的 appId 一致，
// 保证任务栏分组/图标正确（开发模式下不再显示 electron.exe 的默认图标）
app.setAppUserModelId(APP_ID);

// ⚡ 启用 Chromium 手动 GC（配合闲置 GC timer 释放 JS 堆碎片）
// 注：GPU/图片内存靠后端封面缩放控制，不在此限制范围内
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// ── 单实例锁：重复启动时聚焦已有窗口，而不是再拉一套进程（桌面应用标准行为）──
// ⚡ V11.1 锁等待重试：旧实例退出期间（清理 python/vite 需要 taskkill，
// 实测 0.5s~数秒）锁仍被占用。若此时用户双击快捷方式，新实例拿锁失败会
// 静默退出 —— 用户看到的就是"关闭后再也打不开"。
// 处理：拿不到锁先等最多 10 秒；旧实例真死了就接着用（正常启动），
// 还活着说明是"重复启动"，second-instance 已让它聚焦旧窗口，超时后退出。
async function acquireLock() {
  if (app.requestSingleInstanceLock()) return true;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

let mainWin = null;
let lyricWin = null;
let lyricReady = false;
let pendingLyricCfg = null; // 歌词窗口就绪前暂存配置
let backendProc = null;
let frontendProc = null;
let isQuitting = false; // ⚡ V11.1: 退出中标志（second-instance 不再重建窗口）

// ── 启动前清理残留端口 ──
// 上次若被任务管理器强杀，python / vite 会成为孤儿进程继续占用端口，
// 导致本次后端绑定失败。此逻辑从 start-desktop.bat 移入主进程，
// 打包版（直接双击 exe，不经过 bat）同样受益。
function killPortOccupants() {
  if (process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    exec('netstat -ano', { windowsHide: true }, (err, stdout) => {
      if (err) return resolve();
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // TCP  0.0.0.0:8765  0.0.0.0:0  LISTENING  12345
        if (parts.length === 5 && parts[0] === 'TCP' && parts[3] === 'LISTENING') {
          const port = parseInt(parts[1].split(':').pop(), 10);
          if (PORTS.includes(port)) pids.add(parts[4]);
        }
      }
      if (pids.size === 0) return resolve();
      console.log(`[HaiZhe] 清理上次残留的端口进程: PID ${[...pids].join(', ')}`);
      let pending = pids.size;
      for (const pid of pids) {
        exec(`taskkill /f /t /pid ${pid}`, { windowsHide: true }, () => {
          if (--pending === 0) resolve();
        });
      }
    });
  });
}

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

// ── 启动前端（Vite，仅开发模式；打包版直接加载 frontend/dist 静态文件） ──
function startFrontend() {
  if (app.isPackaged) return;
  const frontendDir = path.join(__dirname, '..', 'frontend');
  // ⚡ V11: 直启 vite.js，跳过 npx —— npx 要走 npm 解析（慢 1-3 秒），
  // 甚至可能联网拉包/交互确认（在隐藏窗口里永远卡死，无任何提示）
  const viteJs = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(viteJs)) {
    frontendProc = spawn('node', [viteJs, '--host', '0.0.0.0'], {
      cwd: frontendDir, stdio: 'ignore', windowsHide: true,
    });
  } else {
    frontendProc = spawn('npx', ['vite', '--host', '0.0.0.0'], {
      cwd: frontendDir, stdio: 'ignore', windowsHide: true, shell: true,
    });
  }
  frontendProc.on('error', (err) => console.error('[Frontend] 启动失败:', err.message));
  frontendProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`[Frontend] 异常退出: code=${code}`);
    if (signal) console.error(`[Frontend] 被信号终止: ${signal}`);
  });
}

// ── 清理所有子进程 ──
// 注意：shell:true 时 spawn 出来的是 cmd 壳进程，proc.kill() 只能杀掉壳，
// python / vite 会变孤儿进程继续占端口（旧版启动脚本被迫用 netstat 清端口的原因）。
// Windows 下必须用 taskkill /T /F 杀掉整棵进程树。
// ⚡ V11 关键修正：必须【同步】执行 —— 异步 spawn 的 taskkill 会在主进程
// 退出时被一并带走，根本来不及杀（2026-08-20 现场：退出后 python+vite 存活数小时）
function killProcTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    } catch {}
  } else {
    try { proc.kill('SIGTERM'); } catch {}
  }
}

function cleanup() {
  killProcTree(backendProc);
  killProcTree(frontendProc);
  backendProc = null;
  frontendProc = null;
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
    // 任务栏/标题栏图标（与桌面快捷方式同源，开发模式下不再显示 Electron 默认图标）
    icon: path.join(__dirname, 'icon.ico'),
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
    // ⚡ V11: 主窗口关闭 = 退出应用。否则桌面歌词窗口（skipTaskbar、无关闭按钮）
    // 会让进程变成"无影僵尸"：界面上看起来已关闭，但单实例锁仍被占用，
    // 之后双击快捷方式永远"打不开"（只能重启电脑）。2026-08-20 实际发生过。
    if (process.platform !== 'darwin') { isQuitting = true; app.quit(); }
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

  // ⚡ V11 兜底：万一页面一直加载失败（ready-to-show 永不触发），
  // 15 秒后强制显示窗口 —— 绝不让用户面对"双击后毫无反应"
  setTimeout(() => {
    if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) mainWin.show();
  }, 15000);

  // ⚡ V11: 主页面加载失败自动重试（vite 冷启动竞态：loadURL 早于 vite 监听）
  let loadRetries = 0;
  mainWin.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || !isDev) return;
    if (mainWin && !mainWin.isDestroyed() && loadRetries < 5) {
      loadRetries++;
      setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(url);
      }, 1000);
    }
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

// 音乐目录选择（设置页）
ipcMain.handle('pick-music-dir', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(mainWin, {
    title: '选择音乐文件夹',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ── 生命周期 ──
app.whenReady().then(async () => {
  // ⚡ V11.1: 先拿单实例锁（可能要等旧实例退出释放，最多 10 秒）
  const gotLock = await acquireLock();
  if (!gotLock) { app.quit(); return; } // 旧实例还活着：聚焦旧窗口后自己退出

  // 先清理上次异常退出残留的端口占用，再启动服务
  await killPortOccupants();

  startBackend();
  startFrontend();

  const isDev = !app.isPackaged;
  if (isDev) {
    // ⚡ V11: 并行等待前端/后端就绪（旧版串行等待，总耗时 = 两者之和）。
    // 超时不阻塞开窗 —— 页面加载有 did-fail-load 重试兜底。
    const viteReady = waitForUrl('http://localhost:5173', 20000, 500)
      .catch(err => console.error('[HaiZhe]', err.message));
    const backendReady = waitForUrl('http://localhost:8765/api/status', 20000, 1000)
      .catch(err => console.error('[HaiZhe]', err.message));
    await Promise.all([viteReady, backendReady]);
  }

  createMainWindow();

  // ⚡ 优雅退出：确保子进程被清理
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(); });
  process.on('SIGTERM', () => { cleanup(); process.exit(); });
});

// 重复启动：聚焦已有主窗口；主窗口不在则重建（自愈，防"锁还在、窗口没了"）
app.on('second-instance', () => {
  // ⚡ V11.1: 本实例正在退出时忽略 —— 此时重建窗口只会闪一下然后被销毁，
  // 而且会拖慢退出（锁更晚释放）。新实例有锁重试，等我们退完它自己会起来。
  if (isQuitting) return;
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  } else {
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { isQuitting = true; cleanup(); });
app.on('activate', () => { if (!mainWin && !isQuitting) createMainWindow(); });
