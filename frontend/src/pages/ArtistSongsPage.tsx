// 歌手歌曲列表页

import { useState, useEffect, memo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import type { Song, ArtistInfo } from '../types';
import { api } from '../api';
import { usePlayer } from '../store';
import { CoverThumbnail } from '../components/Sidebar';

function formatDuration(s: number | null): string {
  if (!s) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** 19153182 → 1915.3万 */
function fmtCount(n: number): string {
  if (!n) return '';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/** 歌手简介卡（V13.5）：默认折两行，可展开 */
function ArtistBio({ info }: { info: ArtistInfo }) {
  const [expanded, setExpanded] = useState(false);
  const hasBio = !!info.brief;
  if (!info.found || (!hasBio && info.alias.length === 0 && !info.fans)) return null;
  const long = info.brief.length > 64;

  return (
    <div className="px-8 max-md:px-4 pb-3">
      <div className="glass-light rounded-2xl p-4 flex gap-4">
        {info.avatar && (
          <img src={info.avatar} alt={info.name} loading="lazy"
            className="w-16 h-16 rounded-full object-cover shrink-0 bg-white/5"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium text-white/85">{info.name}</span>
            {info.alias.map(a => (
              <span key={a} className="text-[11px] text-white/25">{a}</span>
            ))}
            {info.fans > 0 && <span className="text-[11px] text-white/20">{fmtCount(info.fans)} 粉丝</span>}
            {info.music_count > 0 && <span className="text-[11px] text-white/20">{info.music_count} 首作品</span>}
          </div>
          {hasBio ? (
            <>
              <p className={`text-[13px] text-white/45 leading-relaxed mt-1.5 ${expanded ? '' : 'line-clamp-2'}`}>
                {info.brief}
              </p>
              {long && (
                <button onClick={() => setExpanded(v => !v)}
                  className="text-[11px] text-[var(--accent)]/70 hover:text-[var(--accent)] mt-1 transition-colors">
                  {expanded ? '收起' : '展开'}
                </button>
              )}
            </>
          ) : (
            <p className="text-[11px] text-white/20 mt-1.5">暂无简介</p>
          )}
        </div>
      </div>
    </div>
  );
}

export const ArtistSongsPage = memo(function ArtistSongsPage() {
  const { name } = useParams<{ name: string }>();
  const artistName = decodeURIComponent(name || '');
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState<ArtistInfo | null>(null);
  const { play, state } = usePlayer();

  useEffect(() => {
    setLoading(true);
    api.getArtistSongs(artistName)
      .then(setSongs)
      .finally(() => setLoading(false));
  }, [artistName]);

  // 歌手简介：独立请求，失败/无数据都不影响歌曲列表
  useEffect(() => {
    setInfo(null);
    let alive = true;
    api.getArtistInfo(artistName)
      .then(d => { if (alive) setInfo(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [artistName]);

  const isCurrent = (s: Song) => state.currentSong?.id === s.id;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Banner - no absolute positioning that would overlap content */}
      <div className="h-40 bg-gradient-to-b from-purple-900/30 via-purple-950/10 to-transparent relative flex items-end px-8 pb-6 max-md:px-4 max-md:h-32">
        <div>
          <Link to="/artists" className="text-white/35 hover:text-white text-xs inline-flex items-center gap-1 mb-2 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
            所有歌手
          </Link>
          <h1 className="text-3xl font-bold max-md:text-2xl">{artistName}</h1>
          <p className="text-white/30 text-sm mt-1">{songs.length} 首歌曲</p>
        </div>
      </div>

      {/* 歌手简介（来自网易云公开接口，失败就整块不显示） */}
      {info && <ArtistBio info={info} />}

      {/* Song list - no sticky header that could block clicks */}
      <div className="px-8 py-2 max-md:px-2">
        {loading ? (
          <div className="space-y-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 p-3">
                <div className="skeleton w-10 h-10 rounded-lg" />
                <div className="flex-1 space-y-2"><div className="skeleton h-4 w-40 rounded" /><div className="skeleton h-3 w-20 rounded" /></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {songs.map((song, i) => (
              <motion.div
                key={song.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.01, 0.3) }}
                onClick={() => play(song, songs)}
                className={`flex items-center gap-4 p-2.5 rounded-xl cursor-pointer transition-all duration-200 group hover:bg-white/5 ${
                  isCurrent(song) ? 'bg-white/8' : ''
                }`}
              >
                <div className="w-7 text-center shrink-0">
                  {isCurrent(song) && state.isPlaying ? (
                    <div className="flex items-center justify-center gap-[2px] h-4">
                      <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[eq_0.5s_ease-in-out_infinite]" style={{ height: 8, animationDelay: '0s' }} />
                      <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[eq_0.5s_ease-in-out_infinite]" style={{ height: 14, animationDelay: '0.15s' }} />
                      <span className="w-[3px] bg-[var(--accent)] rounded-full animate-[eq_0.5s_ease-in-out_infinite]" style={{ height: 5, animationDelay: '0.3s' }} />
                    </div>
                  ) : (
                    <span className="text-xs text-white/15 group-hover:hidden">{i + 1}</span>
                  )}
                  <svg className="hidden group-hover:block w-3.5 h-3.5 mx-auto text-white/50" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
                <CoverThumbnail songId={song.id} size={38} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium truncate ${isCurrent(song) ? 'text-[var(--accent)]' : ''}`}>
                    {song.title}
                  </p>
                  <p className="text-xs text-white/25 truncate">{song.artist}</p>
                </div>
                <span className="text-xs text-white/15 shrink-0 max-md:hidden">{formatDuration(song.duration)}</span>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <style>{`@keyframes eq { 0%,100%{height:4px} 50%{height:16px} }`}</style>
    </div>
  );
});
