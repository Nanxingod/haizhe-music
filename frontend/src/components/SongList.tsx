// 歌曲列表（从 AllSongsPage 抽出，供「全部歌曲 / 我喜欢 / 最近播放 / 歌单」共用）
//
// 性能注意：列表内容必须是独立 memo —— 播放进度每 500ms 变一次，
// 如果跟页面一起渲染，700+ 行会跟着重渲染（V10.1 的教训）。

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { Song } from '../types';
import { CoverThumbnail } from './Sidebar';
import { useLibrary } from '../libraryStore';
import { SongMenu } from './SongMenu';

export function formatDuration(s: number | null): string {
  if (!s) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/* ── 单行 ── */
const SongRow = memo(function SongRow({
  song, index, isCurrent, isPlaying, onPlay,
}: {
  song: Song; index: number; isCurrent: boolean; isPlaying: boolean; onPlay: (song: Song) => void;
}) {
  const { favorites, toggleFav } = useLibrary();
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const handleClick = useCallback(() => onPlay(song), [onPlay, song]);
  const isFav = favorites.has(song.id);

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

      {/* 操作区：已收藏的星星常显，其余 hover 出现 */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={e => { e.stopPropagation(); toggleFav(song.id); }}
          title={isFav ? '取消收藏' : '收藏到「我喜欢」'}
          className={`w-6 h-6 rounded-lg flex items-center justify-center text-[13px] transition-colors hover:bg-white/10 ${
            isFav ? 'text-[var(--accent)]' : 'invisible group-hover:visible text-white/25 hover:text-white/70'
          }`}>
          {isFav ? '★' : '☆'}
        </button>
        <button
          ref={btnRef}
          onClick={e => { e.stopPropagation(); setMenuAt(btnRef.current?.getBoundingClientRect() ?? null); }}
          title="收藏 / 加入歌单"
          className="w-6 h-6 rounded-lg flex items-center justify-center text-white/25 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>
          </svg>
        </button>
      </div>

      <span className="text-xs text-white/15 shrink-0 max-md:hidden">{formatDuration(song.duration)}</span>

      {menuAt && <SongMenu song={song} anchor={menuAt} onClose={() => setMenuAt(null)} />}
    </motion.div>
  );
});

/* ── 列表本体 ── */
export const SongListContent = memo(function SongListContent({
  songs, currentSongId, isPlaying, onPlay, grouped = true,
}: {
  songs: Song[]; currentSongId: string | undefined; isPlaying: boolean;
  onPlay: (song: Song) => void;
  /** 全部歌曲按首字母分组；歌单/收藏/最近播放保持原有顺序 */
  grouped?: boolean;
}) {
  const sections = useMemo(() => {
    if (!grouped) return [{ key: '', songs }];
    const g: Record<string, Song[]> = {};
    for (const s of songs) {
      const first = s.title.charAt(0).toUpperCase();
      const letter = /^[A-Z]$/.test(first) ? first : '#';
      (g[letter] ||= []).push(s);
    }
    return Object.keys(g)
      .sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
      .map(k => ({ key: k, songs: g[k] }));
  }, [songs, grouped]);

  return (
    <div className="px-8 py-4 max-md:px-2">
      {sections.map(sec => (
        <div key={sec.key} className="mb-6 last:mb-0">
          {grouped && (
            <h2 className="text-xl font-bold text-white/12 mb-2 ml-2 sticky top-0 z-[5] py-1">{sec.key}</h2>
          )}
          <div className="space-y-0.5">
            {sec.songs.map((song, i) => (
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
      <style>{`@keyframes eq { 0%,100%{height:4px} 50%{height:16px} }`}</style>
    </div>
  );
});
