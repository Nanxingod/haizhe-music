// 皮肤系统（V14.5）
//
// 做法：皮肤 = 一组 CSS 变量，挂在 <html data-skin="..."> 上。
// 组件里已经在用 var(--accent) / var(--accent-glow)，所以换皮肤时
// 按钮、进度条、选中态、面板描边会一起跟着变，而不是只换背景图。

export type SkinId = 'classic' | 'ocean' | 'forest';

export interface SkinDef {
  id: SkinId;
  name: string;
  desc: string;
  /** 预览用的三色：主色 / 底色 / 辅色 */
  swatch: [string, string, string];
}

export const SKINS: SkinDef[] = [
  {
    id: 'classic', name: '默认', desc: '玫瑰粉 · 暗夜紫',
    swatch: ['#ff6b8a', '#12121f', '#8b7bd8'],
  },
  {
    id: 'ocean', name: '海洋', desc: '深海蓝 · 浪花青',
    swatch: ['#57c8f2', '#072230', '#2ee6c8'],
  },
  {
    id: 'forest', name: '森林', desc: '苔藓绿 · 暖木金',
    swatch: ['#8fd46a', '#0f2416', '#c9a227'],
  },
];

const KEY = 'haizhe-skin';

export function currentSkin(): SkinId {
  try {
    const v = localStorage.getItem(KEY) as SkinId | null;
    if (v && SKINS.some(s => s.id === v)) return v;
  } catch { /* 隐私模式读不到 */ }
  return 'classic';
}

export function applySkin(id: SkinId) {
  document.documentElement.dataset.skin = id;
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
}

/** 取当前生效的主色（给桌面歌词窗口等外部消费者用） */
export function accentColor(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim();
  return v || '#ff6b8a';
}

/** 取当前皮肤的面板底色（桌面歌词背景用） */
export function panelSurface(): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue('--skin-surface').trim();
  return v || 'rgba(15,15,26,0.92)';
}
