// 全部歌曲页 - 按歌名 A-Z 分组展示（V10.2 性能版）
// 列表内容抽到独立 memo 组件，避免每 500ms timeupdate 触发 676 行全量重渲染

import { useState, useEffect, memo, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { Song } from '../types';
import { api } from '../api';
import { usePlayer } from '../store';
import { CoverThumbnail } from '../components/Sidebar';

function formatDuration(s: number | null): string {
  if (!s) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/* ── 歌曲列表内容（独立 memo，songId/isPlaying 不变时不重渲染）── */
const SongListContent = memo(function SongListContent({
  songs, currentSongId, isPlaying, onPlay,
}: {
  songs: Song[]; currentSongId: string | undefined; isPlaying: boolean;
  onPlay: (song: Song) => void;
}) {
  const grouped = useMemo(() => {
    const g: Record<string, Song[]> = {};
    for (const s of songs) {
      const first = s.title.charAt(0).toUpperCase();
      const letter = /^[A-Z]$/.test(first) ? first : '#';
      if (!g[letter]) g[letter] = [];
      g[letter].push(s);
    }
    return g;
  }, [songs]);

  const letters = useMemo(() =>
    Object.keys(grouped).sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    })
  , [grouped]);

  return (
    <div className="px-8 py-4 max-md:px-2">
      {letters.map(letter => (
        <div key={letter} className="mb-6">
          <h2 className="text-xl font-bold text-white/12 mb-2 ml-2 sticky top-[72px] z-[5] py-1">{letter}</h2>
          <div className="space-y-0.5">
            {grouped[letter].map((song, i) => (
              <SongRow
                key={song.id}
                song={song}
                index={i}
                isCurrent={song.id === currentSongId}
                isPlaying={isPlaying && song.id === currentSongId}
                onPlay={onPlay}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});

/* ── 单行（memo，song id 变了才重渲染）── */
const SongRow = memo(function SongRow({
  song, index, isCurrent, isPlaying, onPlay,
}: {
  song: Song; index: number; isCurrent: boolean; isPlaying: boolean; onPlay: (song: Song) => void;
}) {
  const handleClick = useCallback(() => onPlay(song), [onPlay, song]);
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.005, 0.5) }}
      onClick={handleClick}
      className={`flex items-center gap-4 p-2.5 rounded-xl cursor-pointer transition-all duration-200 group hover:bg-white/5 ${
        isCurrent ? 'bg-white/8' : ''
      }`}
    >
      <div className="w-7 text-center shrink-0">
        {isCurrent && isPlaying ? (
          <div className="flex items-center justify-center gap-[2px] h-4">
            <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[eq_0.5s_ease-in-out_infinite]" style={{ height: 8, animationDelay: '0s' }} />
            <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[eq_0.5s_ease-in-out_infinite]" style={{ height: 14, animationDelay: '0.15s' }} />
            <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[eq_0.5s_ease-in-out_infinite]" style={{ height: 5, animationDelay: '0.3s' }} />
          </div>
        ) : (
          <span className="text-xs text-white/15 group-hover:hidden">{index + 1}</span>
        )}
        <svg className="hidden group-hover:block w-3.5 h-3.5 mx-auto text-white/50" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      </div>
      <CoverThumbnail songId={song.id} size={38} />
      <div className="min-w-0 flex-1">
        <p className={`text-sm font-medium truncate ${isCurrent ? 'text-[var(--accent)]' : ''}`}>{song.title}</p>
        <p className="text-xs text-white/25 truncate">{song.artist}</p>
      </div>
      <span className="text-xs text-white/15 shrink-0 max-md:hidden">{formatDuration(song.duration)}</span>
    </motion.div>
  );
});

/* ── 页面外壳（处理加载/刷新，不随 timeupdate 重渲染列表）── */
export const AllSongsPage = memo(function AllSongsPage() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
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
      <div className="sticky top-0 z-10 glass border-b border-white/5 px-8 py-5 max-md:px-4">
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
