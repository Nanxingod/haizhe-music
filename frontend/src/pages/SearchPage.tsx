// 音乐播放器 - 搜索页

import { useState, useEffect, useCallback, memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Song } from '../types';
import { api } from '../api';
import { usePlayer } from '../store';
import { CoverThumbnail } from '../components/Sidebar';

function formatDuration(seconds: number | null): string {
  if (!seconds) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const SearchPage = memo(function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [input, setInput] = useState(query);
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const { play, state } = usePlayer();

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) {
      setSongs([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    api.getSongs(q, 100)
      .then((res) => setSongs(res.songs))
      .catch(() => setSongs([]))
      .finally(() => setLoading(false));
  }, []);

  // Sync URL param
  useEffect(() => {
    setInput(query);
    if (query) doSearch(query);
  }, [query, doSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchParams(input ? { q: input } : {});
  };

  const handlePlay = (song: Song, _index: number) => {
    play(song, songs);
  };

  const isCurrentSong = (song: Song) => state.currentSong?.id === song.id;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Search header：sticky 保留（滚动时搜索框可用），去 glass 蒙版，输入框自带背景+模糊保证可读 */}
      <div className="sticky top-0 z-10 px-8 py-6 max-md:px-4">
        <form onSubmit={handleSubmit}>
          <div className="relative max-w-xl">
            <svg
              className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.3-4.3"/>
            </svg>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="搜索歌曲或歌手..."
              className="w-full bg-black/30 backdrop-blur-md border border-white/10 rounded-xl py-3 pl-12 pr-4 text-white placeholder-white/20 outline-none focus:border-[var(--accent)] focus:bg-black/45 transition-all text-sm"
              autoFocus
            />
          </div>
        </form>
      </div>

      {/* Results */}
      <div className="px-8 py-4 max-md:px-2">
        {!searched && (
          <div className="flex flex-col items-center justify-center py-20 text-white/20">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.3">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <p className="mt-4 text-sm">输入关键词搜索</p>
          </div>
        )}

        {loading && (
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 p-3">
                <div className="skeleton w-10 h-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-40 rounded" />
                  <div className="skeleton h-3 w-20 rounded" />
                </div>
              </div>
            ))}
          </div>
        )}

        {searched && !loading && songs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-white/20">
            <p className="text-lg">未找到相关歌曲</p>
            <p className="text-sm mt-1">试试其他关键词</p>
          </div>
        )}

        {searched && songs.length > 0 && (
          <>
            <p className="text-sm text-white/30 mb-3 px-2">
              找到 {songs.length} 首
            </p>
            <div className="space-y-1">
              {songs.map((song, i) => (
                <motion.div
                  key={song.id}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.01, 0.3) }}
                  onClick={() => handlePlay(song, i)}
                  className={`flex items-center gap-4 p-2.5 rounded-xl cursor-pointer transition-all duration-200 group hover:bg-white/5 ${
                    isCurrentSong(song) ? 'bg-white/10' : ''
                  }`}
                >
                  <div className="w-10 h-10 shrink-0">
                    <CoverThumbnail songId={song.id} size={40} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-medium truncate ${isCurrentSong(song) ? 'text-[var(--accent)]' : ''}`}>
                      {song.title}
                    </p>
                    <p className="text-xs text-white/30 truncate">{song.artist}</p>
                  </div>
                  <span className="text-xs text-white/20 shrink-0 max-md:hidden">
                    {formatDuration(song.duration)}
                  </span>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
});
