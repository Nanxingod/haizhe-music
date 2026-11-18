// 全部歌曲页 - 按歌名 A-Z 分组展示（V10.2 性能版）
// 列表内容抽到独立 memo 组件，避免每 500ms timeupdate 触发 676 行全量重渲染

import { useState, useEffect, memo, useCallback } from 'react';
import type { Song } from '../types';
import { api } from '../api';
import { usePlayer } from '../store';
import { SongListContent } from '../components/SongList';
import { OPEN_ONB_EVENT, LIB_EVENT } from '../components/Onboarding';

/* ── 页面外壳（处理加载/刷新，不随 timeupdate 重渲染列表）── */
export const AllSongsPage = memo(function AllSongsPage() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { play, state } = usePlayer();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      for (let retry = 0; retry < 10; retry++) {
        if (cancelled) return;
        try {
          const r = await api.getSongs('', 1000);
          if (!cancelled) { setSongs(r.songs); setLoading(false); }
          return;
        } catch {
          if (retry < 9) await new Promise(r => setTimeout(r, 500));
        }
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [reloadKey]);

  // 引导里设完目录 / 别处重扫后广播 → 这里重新拉一次，不用刷新页面
  useEffect(() => {
    const reload = () => setReloadKey(k => k + 1);
    window.addEventListener(LIB_EVENT, reload);
    return () => window.removeEventListener(LIB_EVENT, reload);
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await api.refreshSongs(); } catch {}
    try {
      const r = await api.getSongs('', 1000);
      setSongs(r.songs);
    } catch {}
    setRefreshing(false);
  };

  // 稳定回调，不随 timeupdate 变化
  const handlePlay = useCallback((song: Song) => play(song, songs), [play, songs]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 pt-5 pb-2 max-md:px-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold max-md:text-xl">全部歌曲</h1>
            <p className="text-white/30 text-sm mt-0.5">{songs.length} 首</p>
          </div>
          <button onClick={handleRefresh} disabled={refreshing}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${
              refreshing ? 'bg-white/5 text-white/15 cursor-not-allowed' : 'bg-white/5 text-white/35 hover:bg-white/10 hover:text-white/60'
            }`}
            title="重新扫描歌曲库（增删歌曲后点此刷新）">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={refreshing ? 'animate-spin' : ''}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3">
              <div className="skeleton w-10 h-10 rounded-lg" />
              <div className="flex-1 space-y-2"><div className="skeleton h-4 w-48 rounded" /><div className="skeleton h-3 w-24 rounded" /></div>
            </div>
          ))}
        </div>
      ) : songs.length === 0 ? (
        /* 空曲库：新用户第一眼看到的就是这里，必须给出下一步动作 */
        <div className="flex flex-col items-center justify-center py-16 px-6 gap-3 text-center">
          <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center text-white/25 text-xl">♪</div>
          <p className="text-[15px] text-white/70">曲库还是空的</p>
          <p className="text-[12px] text-white/35 leading-relaxed max-w-[400px]">
            把 mp3 放进一个文件夹，然后设置音乐目录 —— 会自动扫描子目录，
            并读取同名的 .lrc 歌词文件。
          </p>
          <button
            onClick={() => window.dispatchEvent(new Event(OPEN_ONB_EVENT))}
            className="mt-1 px-4 py-2 rounded-xl text-[13px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors">
            设置音乐目录
          </button>
          <p className="text-[11px] text-white/20">已经放过歌了？点右上角「刷新」重新扫描</p>
        </div>
      ) : (
        <SongListContent
          songs={songs}
          currentSongId={state.currentSong?.id}
          isPlaying={state.isPlaying}
          onPlay={handlePlay}
        />
      )}

      <style>{`@keyframes eq { 0%,100%{height:4px} 50%{height:16px} }`}</style>
    </div>
  );
});
