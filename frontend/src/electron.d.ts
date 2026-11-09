// Electron API 类型声明
interface ElectronAPI {
  lyricShow: () => void;
  lyricHide: () => void;
  lyricUpdate: (data: { idx: number; text: string; next: string; next2?: string }) => void;
  lyricLock: (locked: boolean) => void;
  onLyricLockState: (cb: (locked: boolean) => void) => () => void;
  lyricConfig: (cfg: {
    bgDark?: number; color?: string; fontSize?: number; fontFamily?: string;
    skin?: { accent?: string; surface?: string; border?: string; name?: string };
  }) => void;
  pickMusicDir: () => Promise<string | null>;
  /** V13：用系统默认浏览器打开外链，返回是否成功 */
  openExternal: (url: string) => Promise<boolean>;
}

interface Window {
  electronAPI?: ElectronAPI;
}
