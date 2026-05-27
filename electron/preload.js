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
});
