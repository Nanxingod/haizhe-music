// 桌面歌词悬浮窗 - 半透明条，显示当前歌词行

import { useState, useEffect } from 'react';
import { usePlayer } from '../store';
import type { Lyrics } from '../types';
import { api } from '../api';

export function FloatingLyrics() {
  const { state } = usePlayer();
  const { currentSong, currentTime } = state;
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);

  // 换歌时重新加载歌词
  useEffect(() => {
    setLyrics(null);
    if (!currentSong?.has_lrc) return;
    api.getLyrics(currentSong.id).then(setLyrics).catch(() => {});
  }, [currentSong?.id]);

  // 找当前歌词行
  const activeLine = lyrics
    ? lyrics.lines.findLast(l => l.time <= currentTime)
    : null;

  // 预览下一行
  const activeIdx = lyrics ? lyrics.lines.findLastIndex(l => l.time <= currentTime) : -1;
  const nextLine = lyrics && activeIdx >= 0 && activeIdx < lyrics.lines.length - 1
    ? lyrics.lines[activeIdx + 1]
    : null;

  if (!currentSong || !activeLine) return null;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none max-md:top-2">
      <div className="glass-light rounded-2xl px-5 py-2.5 flex flex-col items-center max-w-lg backdrop-blur-xl max-md:px-3 max-md:py-1.5"
        style={{
          background: 'rgba(0,0,0,0.55)',
          border: '1px solid rgba(255,255,255,0.06)',
          boxShadow: '0 4px 30px rgba(0,0,0,0.4)',
        }}
      >
        {/* 当前行 */}
        <p
          className="text-white text-base font-semibold transition-all duration-300 max-md:text-sm"
          style={{
            fontFamily: "'Noto Serif SC', 'Georgia', 'Songti SC', serif",
            letterSpacing: '0.03em',
            textShadow: '0 0 12px rgba(255,107,138,0.4)',
          }}
        >
          {activeLine.text || '♪'}
        </p>
        {/* 下一行预览 */}
        {nextLine && (
          <p className="text-white/15 text-xs mt-0.5 transition-all duration-300 max-md:hidden"
            style={{ fontFamily: "'Noto Serif SC', serif" }}
          >
            {nextLine.text || '♪'}
          </p>
        )}
      </div>
    </div>
  );
}
