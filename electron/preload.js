// Electron 预加载脚本
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (cb) => {
    ipcRenderer.on('window-maximized', (_e, v) => cb(v));
    ipcRenderer.on('window-unmaximized', (_e, v) => cb(v));
  },
  // 桌面歌词
  lyricShow: () => ipcRenderer.send('lyric-show'),
  lyricHide: () => ipcRenderer.send('lyric-hide'),
  lyricUpdate: (data) => ipcRenderer.send('lyric-update', data),
  lyricConfig: (cfg) => ipcRenderer.send('lyric-config', cfg),
  lyricLock: (locked) => ipcRenderer.send('lyric-lock', !!locked),
  // 主进程回推锁定状态（在桌词窗口里点的锁也要让主窗口知道）
  onLyricLockState: (cb) => {
    const h = (_e, v) => cb(v);
    ipcRenderer.on('lyric-lock-state', h);
    return () => ipcRenderer.removeListener('lyric-lock-state', h);
  },
  // 音乐目录选择
  pickMusicDir: () => ipcRenderer.invoke('pick-music-dir'),
  // ⚡ V13: 用系统默认浏览器打开外链（相关视频推荐面板）
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
