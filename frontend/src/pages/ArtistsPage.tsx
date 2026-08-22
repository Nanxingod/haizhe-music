// 音乐播放器 - 歌手列表页

import { useState, useEffect, memo } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { Artist } from '../types';
import { api } from '../api';

export const ArtistsPage = memo(function ArtistsPage() {
  const [artists, setArtists] = useState<Artist[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getArtists().then((data) => {
      setArtists(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Group by first letter
  const grouped: Record<string, Artist[]> = {};
  for (const artist of artists) {
    const letter = /^[a-zA-Z]/.test(artist.name)
      ? artist.name[0].toUpperCase()
      : '#';
    if (!grouped[letter]) grouped[letter] = [];
    grouped[letter].push(artist);
  }

  const letters = Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  if (loading) {
    return (
      <div className="flex-1 p-8 flex items-center justify-center">
        <div className="space-y-4 w-full max-w-2xl">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="skeleton w-14 h-14 rounded-full" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-4 w-32 rounded" />
                <div className="skeleton h-3 w-16 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Header */}
      <div className="px-8 pt-6 pb-2 max-md:px-4">
        <h1 className="text-3xl font-bold max-md:text-2xl">歌手</h1>
        <p className="text-white/40 text-sm mt-1">{artists.length} 位歌手</p>
      </div>

      {/* Artist list by letter */}
      <div className="px-8 py-6 max-md:px-4">
        {letters.map((letter) => (
          <div key={letter} className="mb-8">
            <h2 className="text-2xl font-bold text-white/15 mb-4 ml-2">{letter}</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              <AnimatePresence>
                {grouped[letter].map((artist, i) => (
                  <motion.div
                    key={artist.name}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                  >
                    <Link
                      to={`/artist/${encodeURIComponent(artist.name)}`}
                      className="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all duration-200 group"
                    >
                      {/* Avatar */}
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center text-white font-bold text-lg shrink-0 group-hover:scale-105 transition-transform">
                        {artist.cover_song_id ? (
                          <img
                            src={api.coverUrl(artist.cover_song_id)}
                            alt=""
                            className="w-full h-full rounded-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                              const parent = (e.target as HTMLImageElement).parentElement!;
                              parent.textContent = artist.name[0] || '♪';
                            }}
                          />
                        ) : (
                          artist.name[0] || '♪'
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{artist.name}</p>
                        <p className="text-xs text-white/30">{artist.song_count} 首</p>
                      </div>
                    </Link>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
