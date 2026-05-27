// Electron API 类型声明
interface ElectronAPI {
  lyricShow: () => void;
  lyricHide: () => void;
  lyricUpdate: (data: { text: string; next: string }) => void;
  lyricConfig: (cfg: { bgDark?: number; color?: string; fontSize?: number; fontFamily?: string }) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
