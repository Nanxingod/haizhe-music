// Electron 主进程 - 海蜇音乐桌面版（V11 桌面体验优化版）
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const { spawn, exec, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const APP_ID = 'com.haizhe.music';
const PORTS = [8765, 5173]; // 后端 / Vite

// ⚡ V13.1: 子进程日志。之前 startBackend/startFrontend 都用 stdio:'ignore'，
// python/vite 崩溃时 Electron 里只有 console.error，而应用是隐藏窗口启动的，
// console 无处可看 —— 现场出现"前端服务没了、页面全是 Failed to fetch"却查不到原因。
//
// ⚠️ V13.4 修正：这里必须用**同步打开的 fd**，不能用 fs.createWriteStream。
// createWriteStream 是异步打开的，spawn 执行时 stream.fd 还是 null，
// Node 会直接抛 `ERR_INVALID_ARG_VALUE: The argument 'stdio' is invalid`，
// 导致 startBackend() 中断、startFrontend() 根本轮不到执行 —— 表现就是
// 双进程都没起、窗口黑屏。这个坑踩过一次，别再改回去。
const LOG_DIR = path.join(__dirname, '..', 'logs');
let backendFd = null;
let frontendFd = null;

function openLogs() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const header = `=== HaiZhe Music ${new Date().toISOString()} ===\n`;
    backendFd = fs.openSync(path.join(LOG_DIR, 'backend.log'), 'w');
    frontendFd = fs.openSync(path.join(LOG_DIR, 'frontend.log'), 'w');
    fs.writeSync(backendFd, header);
    fs.writeSync(frontendFd, header);
  } catch (e) {
    console.error('[Log] 日志初始化失败:', e.message);
    backendFd = null;
    frontendFd = null;
  }
}

/** 子进程 stdio：用同步 fd，spawn 时才合法 */
function childStdio(fd) {
  return fd !== null ? ['ignore', fd, fd] : 'ignore';
}

/** 往日志里补一行（spawn 失败/退出码这类信息只走 console 等于没记录） */
function logTo(fd, tag, msg) {
  try {
    if (fd !== null) {
      fs.writeSync(fd, `[${new Date().toISOString()}] ${tag} ${msg}\n`);
    }
  } catch { /* 日志失败不能影响启动 */ }
}

// ⚡ V13.3: 显式解析 python 解释器。
// 双击快捷方式启动时，进程继承的是 explorer 的 PATH —— 常常和终端里不一样，
// 找不到 python 就 spawn ENOENT，表现为「窗口打开但黑屏、后端根本没起」。
// 这里按优先级探测，把实际用的是哪个写进日志。
const PY_CANDIDATES = [
  'D:\\Anaconda\\python.exe',        // 本机后端依赖（fastapi/mutagen）装在这里
  'D:\\Anaconda3\\python.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
  'C:\\Python313\\python.exe',
  'python',
];

let cachedPython = null;

function pickPython() {
  if (cachedPython) return cachedPython;
  for (const cand of PY_CANDIDATES) {
    try {
      execFileSync(cand, ['-V'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      cachedPython = cand;
      return cand;
    } catch { /* 试下一个 */ }
  }
  cachedPython = 'python';   // 都没探到就交给 PATH，失败会在日志里留 spawn-error
  return cachedPython;
}

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
let lyricLocked = false;   // 桌词锁定 = 鼠标穿透 + 不可拖动
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
// ⚡ V13.1: 崩溃自动重启。后端挂了 = 没声音，比页面挂更难受。
// 只重启"非主动退出"且非 0 码；连续崩溃 3 次就停手，避免无限刷。
let quitting = false;
let backendRestarts = 0;
let frontendRestarts = 0;
const RESTART_MAX = 3;
const HEALTHY_UPTIME_MS = 60000;   // 活过 1 分钟算"健康"，重置计数

function startBackend() {
  const isDev = !app.isPackaged;
  const backendDir = isDev
    ? path.join(__dirname, '..', 'backend')
    : path.join(process.resourcesPath, 'backend');
  // 记录 python 是否真的能被解析到 —— GUI 启动时 PATH 可能和终端里不一样，
  // spawn 失败只会静默留空日志，这一行能把情况说清楚
  const py = pickPython();
  try {
    const ver = execFileSync(py, ['-V'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    logTo(backendFd, '[env]', `python = ${ver}  (${py})`);
  } catch (e) {
    logTo(backendFd, '[env]', `python 不可用 (${py}): ${e.message}`);
  }
  const startedAt = Date.now();
  backendProc = spawn(py, ['main.py'], {
    cwd: backendDir, stdio: childStdio(backendFd), windowsHide: true,
  });
  logTo(backendFd, '[spawn]', `pid=${backendProc.pid || '?'} exe=${py} cwd=${backendDir}`);
  backendProc.on('error', (err) => {
    console.error('[Backend] 启动失败:', err.message);
    logTo(backendFd, '[spawn-error]', err.message);   // 例如 ENOENT: python 不在 PATH
  });
  // V10.3: 记录后端退出信息（崩溃/被杀时能排查原因）
  backendProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`[Backend] 异常退出: code=${code}`);
    if (signal) console.error(`[Backend] 被信号终止: ${signal}`);
    logTo(backendFd, '[exit]', `code=${code} signal=${signal}`);
    if (quitting) return;
    if (Date.now() - startedAt > HEALTHY_UPTIME_MS) backendRestarts = 0;
    if (backendRestarts >= RESTART_MAX) {
      console.error(`[Backend] 已连续重启 ${RESTART_MAX} 次，放弃。看 logs/backend.log`);
      return;
    }
    backendRestarts += 1;
    console.error(`[Backend] 3 秒后重启（第 ${backendRestarts}/${RESTART_MAX} 次）`);
    setTimeout(() => { if (!quitting) startBackend(); }, 3000);
  });
}

// ── 启动前端（Vite，仅开发模式；打包版直接加载 frontend/dist 静态文件） ──
function startFrontend() {
  if (app.isPackaged) return;
  const frontendDir = path.join(__dirname, '..', 'frontend');
  // ⚡ V11: 直启 vite.js，跳过 npx —— npx 要走 npm 解析（慢 1-3 秒），
  // 甚至可能联网拉包/交互确认（在隐藏窗口里永远卡死，无任何提示）
  const viteJs = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const startedAt = Date.now();
  if (fs.existsSync(viteJs)) {
    frontendProc = spawn('node', [viteJs, '--host', '0.0.0.0'], {
      cwd: frontendDir, stdio: childStdio(frontendFd), windowsHide: true,
    });
  } else {
    frontendProc = spawn('npx', ['vite', '--host', '0.0.0.0'], {
      cwd: frontendDir, stdio: childStdio(frontendFd), windowsHide: true, shell: true,
    });
  }
  logTo(frontendFd, '[spawn]', `pid=${frontendProc.pid || '?'} cwd=${frontendDir}`);
  frontendProc.on('error', (err) => {
    console.error('[Frontend] 启动失败:', err.message);
    logTo(frontendFd, '[spawn-error]', err.message);
  });
  frontendProc.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`[Frontend] 异常退出: code=${code}`);
    if (signal) console.error(`[Frontend] 被信号终止: ${signal}`);
    logTo(frontendFd, '[exit]', `code=${code} signal=${signal}`);
    // V13.1: Vite 掉了 = 渲染进程所有 /api 请求变 Failed to fetch、音乐停播，
    // 但窗口还开着，用户只会觉得"卡死了"。必须自愈。
    if (quitting) return;
    if (Date.now() - startedAt > HEALTHY_UPTIME_MS) frontendRestarts = 0;
    if (frontendRestarts >= RESTART_MAX) {
      console.error(`[Frontend] 已连续重启 ${RESTART_MAX} 次，放弃。看 logs/frontend.log`);
      return;
    }
    frontendRestarts += 1;
    console.error(`[Frontend] 2 秒后重启（第 ${frontendRestarts}/${RESTART_MAX} 次）`);
    setTimeout(() => { if (!quitting) startFrontend(); }, 2000);
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
  quitting = true;              // 主动退出：别让 exit 处理器把子进程又拉起来
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
  // ⚡ 幂等：本函数有三条调用路径（whenReady 的启动流程 / second-instance / activate），
  // 而启动流程会 await 前端后端就绪（最长 20s），这段时间 mainWin 仍是 null。
  // 若用户此时再双击一次，second-instance 会抢先生成窗口①；等启动流程走完
  // 又生成窗口② —— 一个进程里出现两个播放器窗口（2026-11-07 实际发生）。
  // 已有窗口时只做聚焦，绝不再 new。
  if (mainWin && !mainWin.isDestroyed()) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
    return mainWin;
  }

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
  // ⚡ V13.3: 重试 5 次仍失败 → 加载一张"说人话"的错误页，而不是留一片黑屏
  let loadRetries = 0;
  let fallbackShown = false;
  mainWin.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || !isDev) return;
    if (!mainWin || mainWin.isDestroyed()) return;
    if (loadRetries < 5) {
      loadRetries++;
      setTimeout(() => {
        if (mainWin && !mainWin.isDestroyed()) mainWin.loadURL(url);
      }, 1000);
      return;
    }
    if (fallbackShown) return;
    fallbackShown = true;
    showStartupError(_desc);
  });
}

/** 前端起不来时的兜底页：把"黑屏"换成可读的诊断信息 */
function showStartupError(desc) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;background:#0f1020;color:#e8e8f0;
  font:14px/1.8 "Microsoft YaHei",-apple-system,sans-serif;
  display:flex;align-items:center;justify-content:center}
.box{max-width:560px;padding:26px 30px;border:1px solid rgba(255,255,255,.1);
  border-radius:16px;background:rgba(255,255,255,.04)}
h1{font-size:16px;margin:0 0 12px;color:#ff9eaf}
p{margin:6px 0;color:#b9b9cc}
code{background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:12px;color:#e8e8f0}
.tip{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08);color:#8b8ba0;font-size:12px}
</style></head><body><div class="box">
<h1>前端服务没有启动起来</h1>
<p>窗口已经打开，但加载 <code>http://localhost:5173</code> 失败${desc ? `（${desc}）` : ''}。</p>
<p>Vite 进程可能没起来：依赖缺失、端口被占，或者 PATH 里找不到 node。</p>
<div class="tip">
诊断日志：<br>
<code>${path.join(LOG_DIR, 'frontend.log')}</code><br>
<code>${path.join(LOG_DIR, 'backend.log')}</code><br><br>
先关掉这个窗口重新打开；仍然这样，把上面两个文件的内容发出来。
</div>
</div></body></html>`;
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }
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
    applyLyricLock();          // 重建窗口后恢复锁定状态
    // 如果窗口加载期间有配置到达，现在应用它
    if (lyricWin && !lyricWin.isDestroyed()) {
      lyricWin.webContents.send('lyric-config', pendingLyricCfg || {});
    }
    pendingLyricCfg = null;
  });
  lyricWin.on('closed', () => { lyricWin = null; lyricReady = false; stopLockWatch(); });
}

// ── IPC ──
ipcMain.on('window-minimize', () => mainWin?.minimize());
ipcMain.on('window-maximize', () => mainWin?.isMaximized() ? mainWin.unmaximize() : mainWin?.maximize());
ipcMain.on('window-close', () => mainWin?.close());
/**
 * 应用锁定状态。
 * 锁住 = setIgnoreMouseEvents(true, {forward:true})：鼠标事件穿透到下面的窗口，
 * 打游戏时完全不挡操作。代价是页面收不到 hover —— 所以"悬停 3 秒出解锁键"
 * 只能由主进程轮询光标位置来实现（见 startLockWatch）。
 */
function applyLyricLock() {
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.setIgnoreMouseEvents(lyricLocked, { forward: true });
    if (lyricWin.webContents && !lyricWin.webContents.isDestroyed()) {
      lyricWin.webContents.send('lyric-lock', lyricLocked);
    }
  }
  // 同步给主窗口：解锁提示条/按钮角标/设置开关都靠这个状态
  if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
    mainWin.webContents.send('lyric-lock-state', lyricLocked);
  }
  if (lyricLocked) startLockWatch(); else stopLockWatch();
}

// ── 锁定时的"悬停 3 秒出解锁键" ──
// 锁住后窗口鼠标穿透，页面收不到任何鼠标事件，所以只能由主进程轮询光标。
// 规则：光标在**整个悬浮窗范围内**连续停留 3 秒 → 临时放开穿透并显示解锁键；
//       移出窗口后给 0.5 秒宽限（只是防手抖，一般离开就是不打算点了）。
const DWELL_MS = 3000;
const GRACE_MS = 500;

let lockWatch = null;
let insideSince = 0;
let leftAt = 0;
let hintArmed = false;

function stopLockWatch() {
  if (lockWatch) { clearInterval(lockWatch); lockWatch = null; }
  insideSince = 0;
  leftAt = 0;
  hintArmed = false;
}

function disarmHint() {
  if (!hintArmed) return;
  hintArmed = false;
  if (lyricWin && !lyricWin.isDestroyed()) {
    lyricWin.setIgnoreMouseEvents(true, { forward: true });
    if (lyricWin.webContents && !lyricWin.webContents.isDestroyed()) {
      lyricWin.webContents.send('lyric-lock-hint', false);
    }
  }
}

function startLockWatch() {
  stopLockWatch();
  lockWatch = setInterval(() => {
    if (!lyricLocked) return;
    if (!lyricWin || lyricWin.isDestroyed() || !lyricWin.isVisible()) return;

    let pt;
    try { pt = screen.getCursorScreenPoint(); } catch { return; }
    const b = lyricWin.getBounds();
    const inside = pt.x >= b.x && pt.x <= b.x + b.width &&
                   pt.y >= b.y && pt.y <= b.y + b.height;

    if (inside) {
      leftAt = 0;
      if (!insideSince) insideSince = Date.now();
      if (!hintArmed && Date.now() - insideSince >= DWELL_MS) {
        hintArmed = true;
        lyricWin.setIgnoreMouseEvents(false);   // 临时放开，让解锁键可点
        if (lyricWin.webContents && !lyricWin.webContents.isDestroyed()) {
          lyricWin.webContents.send('lyric-lock-hint', true);
        }
      }
    } else {
      insideSince = 0;
      if (hintArmed) {
        if (!leftAt) leftAt = Date.now();
        if (Date.now() - leftAt >= GRACE_MS) disarmHint();
      }
    }
  }, 200);
}

ipcMain.on('lyric-lock', (_e, locked) => {
  lyricLocked = !!locked;
  applyLyricLock();
});

ipcMain.on('lyric-show', () => {
  if (!lyricWin || lyricWin.isDestroyed()) createLyricWindow(); else lyricWin.show();
});
// 桌词窗口按内容自适应高度：固定 80px 装不下「两行 + 内边距」，
// 会被裁掉半行字，看起来像字"长出来"了。以中心为锚调整，视觉位置不跳。
ipcMain.on('lyric-resize', (_e, h) => {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  const b = lyricWin.getBounds();
  const nh = Math.max(48, Math.min(260, Math.round(Number(h) || 0)));
  if (Math.abs(nh - b.height) < 2) return;
  const dy = Math.round((b.height - nh) / 2);
  lyricWin.setBounds({ x: b.x, y: b.y + dy, width: b.width, height: nh });
});

// 桌词宽度自适应（超长句要放得下）：以中心为锚左右扩，屏幕装不下时页面会自己缩字号
ipcMain.on('lyric-resize-w', (_e, w) => {
  if (!lyricWin || lyricWin.isDestroyed()) return;
  const b = lyricWin.getBounds();
  const nw = Math.max(200, Math.min(Math.round(Number(w) || 0), 1600));
  if (Math.abs(nw - b.width) < 4) return;
  const dx = Math.round((b.width - nw) / 2);
  lyricWin.setBounds({ x: b.x + dx, y: b.y, width: nw, height: b.height });
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

// ⚡ V13: 用系统默认浏览器打开外链（相关视频面板）
// 只放行 http/https —— 防止 file:// 或自定义协议被滥用
ipcMain.handle('open-external', async (_e, url) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    await shell.openExternal(u.toString());
    return true;
  } catch {
    return false;
  }
});

// ── 生命周期 ──
app.whenReady().then(async () => {
  // ⚡ V11.1: 先拿单实例锁（可能要等旧实例退出释放，最多 10 秒）
  const gotLock = await acquireLock();
  if (!gotLock) { app.quit(); return; } // 旧实例还活着：聚焦旧窗口后自己退出

  // 先清理上次异常退出残留的端口占用，再启动服务
  await killPortOccupants();

  openLogs();          // ⚡ V13.1: 子进程日志落盘（logs/backend.log、frontend.log）
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
