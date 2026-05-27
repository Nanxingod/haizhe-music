// Electron 自定义标题栏（拖拽 + 窗口按钮）
import { memo } from 'react';

export const TitleBar = memo(function TitleBar() {
  const ea = (window as any).electronAPI;
  if (!ea) return null; // 非 Electron 环境不显示

  return (
    <div
      className="h-9 glass shrink-0 flex items-center justify-between px-2 select-none z-50"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 标题 */}
      <span className="text-white/30 text-xs pl-3">海蜇音乐</span>

      {/* 窗口按钮 */}
      <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => ea.minimize()}
          className="w-10 h-9 flex items-center justify-center text-white/30 hover:text-white hover:bg-white/5 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button
          onClick={() => ea.maximize()}
          className="w-10 h-9 flex items-center justify-center text-white/30 hover:text-white hover:bg-white/5 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        <button
          onClick={() => ea.close()}
          className="w-10 h-9 flex items-center justify-center text-white/30 hover:text-white hover:bg-red-500/60 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1.5" y1="1.5" x2="10.5" y2="10.5" stroke="currentColor" strokeWidth="1.2"/><line x1="10.5" y1="1.5" x2="1.5" y2="10.5" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  );
});
