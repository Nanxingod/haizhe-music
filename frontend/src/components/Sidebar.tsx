// 音乐播放器 - 侧边栏

import { memo, useState, useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api';

export const Sidebar = memo(function Sidebar() {
  return (
    <aside className="w-[240px] h-full glass sidebar-bg flex flex-col shrink-0 max-lg:w-[64px] overflow-hidden">
      {/* Logo */}
      <div className="p-5 max-lg:p-3 relative z-[1]">
        <h1 className="text-2xl font-bold text-gradient max-lg:hidden tracking-tight">
          🎵 海蜇音乐
        </h1>
        <h1 className="text-xl font-bold text-gradient lg:hidden text-center">
          🎵
        </h1>
      </div>

      {/* Nav - 加大间距 */}
      <nav className="flex-1 px-3 mt-2 space-y-2 relative z-[1]">
        <NavLink
          to="/"
          end
          className={({ isActive }: { isActive: boolean }) =>
            `flex items-center gap-3 px-4 py-3 rounded-xl text-[16px] font-medium transition-all duration-200 max-lg:justify-center max-lg:px-2 ${
              isActive
                ? 'bg-white/12 text-white shadow-sm'
                : 'text-white/50 hover:text-white hover:bg-white/6'
            }`
          }
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
          <span className="max-lg:hidden">全部歌曲</span>
        </NavLink>

        <NavLink
          to="/artists"
          className={({ isActive }: { isActive: boolean }) =>
            `flex items-center gap-3 px-4 py-3 rounded-xl text-[16px] font-medium transition-all duration-200 max-lg:justify-center max-lg:px-2 ${
              isActive
                ? 'bg-white/12 text-white shadow-sm'
                : 'text-white/50 hover:text-white hover:bg-white/6'
            }`
          }
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span className="max-lg:hidden">歌手</span>
        </NavLink>

        <NavLink
          to="/search"
          className={({ isActive }: { isActive: boolean }) =>
            `flex items-center gap-3 px-4 py-3 rounded-xl text-[16px] font-medium transition-all duration-200 max-lg:justify-center max-lg:px-2 ${
              isActive
                ? 'bg-white/12 text-white shadow-sm'
                : 'text-white/50 hover:text-white hover:bg-white/6'
            }`
          }
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
          </svg>
          <span className="max-lg:hidden">搜索</span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }: { isActive: boolean }) =>
            `flex items-center gap-3 px-4 py-3 rounded-xl text-[16px] font-medium transition-all duration-200 max-lg:justify-center max-lg:px-2 ${
              isActive
                ? 'bg-white/12 text-white shadow-sm'
                : 'text-white/50 hover:text-white hover:bg-white/6'
            }`
          }
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span className="max-lg:hidden">设置</span>
        </NavLink>
      </nav>

      {/* 底部装饰区 */}
      <div className="mt-auto relative z-[1] max-lg:hidden">
        {/* 音符波浪装饰 */}
        <div className="px-4 pb-4 opacity-30">
          <svg width="100%" height="40" viewBox="0 0 200 40" fill="none">
            <path d="M10 20 Q30 5, 50 20 T90 20 T130 20 T170 20" stroke="rgba(255,255,255,0.4)" strokeWidth="1" fill="none"/>
            <circle cx="30" cy="18" r="3" fill="rgba(255,107,138,0.5)"/>
            <circle cx="70" cy="22" r="2" fill="rgba(255,255,255,0.3)"/>
            <circle cx="110" cy="17" r="2.5" fill="rgba(255,107,138,0.4)"/>
            <circle cx="150" cy="21" r="2" fill="rgba(255,255,255,0.3)"/>
          </svg>
          {/* 小音符 */}
          <div className="flex justify-center gap-2 mt-2">
            <span className="text-white/20 text-lg">♩</span>
            <span className="text-white/15 text-lg">♪</span>
            <span className="text-white/20 text-lg">♫</span>
            <span className="text-white/15 text-lg">♬</span>
          </div>
          <p className="text-center text-white/10 text-xs mt-2 tracking-wider">✦ 海蜇音乐 ✦</p>
        </div>
      </div>
    </aside>
  );
});

export const CoverThumbnail = memo(function CoverThumbnail({ songId, size = 56, eager }: { songId: string; size?: number; eager?: boolean }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgState, setImgState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [forceReload, setForceReload] = useState(0);

  // songId 变化时重置状态（img src 由 render 阶段直接设为新 URL，这里只清状态）
  useEffect(() => { setImgState('loading'); }, [songId]);

  // 仅在组件卸载时清空 src（释放 Chromium 解码位图）。
  // ⚠️ 不能在 songId change cleanup 里清——React cleanup 在 render 之后执行，
  // 会把 render 刚设好的新 cover URL 也一并清掉，导致永久白屏。
  useEffect(() => {
    return () => { if (imgRef.current) imgRef.current.src = ''; };
  }, []);

  // 仅 eager 模式（播放栏）：窗口最小化恢复后 GPU 可能已驱逐解码位图 → 强制重载
  // ⚠️ 不在列表项上挂 visibility 监听，避免 676 张图同时重载风暴
  useEffect(() => {
    if (!eager) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        requestAnimationFrame(() => {
          setForceReload(n => n + 1);
          setImgState('loading');
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [eager]);

  return (
    <div className="shrink-0 rounded-lg overflow-hidden bg-white/5 flex items-center justify-center text-white/15"
         style={{ width: size, height: size }}>
      {imgState === 'error' ? (
        <svg width={Math.min(24, size * 0.6)} height={Math.min(24, size * 0.6)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
      ) : (
        <img
          ref={imgRef}
          src={`${api.coverUrl(songId, 150)}${forceReload ? `#r=${forceReload}` : ''}`}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          {...(eager ? { fetchpriority: 'high' as const } : {})}
          className="w-full h-full object-cover"
          onLoad={() => setImgState('ok')}
          onError={() => setImgState('error')}
        />
      )}
    </div>
  );
});
