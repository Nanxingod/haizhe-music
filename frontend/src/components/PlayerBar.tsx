// 音乐播放器 - 播放栏 + 全屏播放页 + 桌面歌词
// V8 性能优化：高频读 ref 跳过 React 渲染链路

import { useState, useEffect, useRef, useCallback } from 'react';
import { usePlayer, timeRef, durRef } from '../store';
import type { Lyrics } from '../types';
import { api } from '../api';
import { CoverThumbnail } from './Sidebar';

function fmt(s: number): string {
  if (!s || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/* ── 桌面歌词悬浮窗（Document PiP） ── */
let pipWin: Window | null = null;

function readPipCfg() {
  return {
    bgDark: Number(localStorage.getItem('haizhe-pip-bg') || 0.75),
    color: localStorage.getItem('haizhe-pip-color') || '#ff9eaf',
    fontSize: Number(localStorage.getItem('haizhe-pip-size') || 20),
    fontFamily: (() => {
      const map: Record<string,string> = {
        'noto-serif': "'Noto Serif SC',serif", 'noto-sans': "'Noto Sans SC',sans-serif",
        'kuaile': "'ZCOOL KuaiLe',sans-serif", 'xiaowei': "'ZCOOL XiaoWei',serif",
        'mashan': "'Ma Shan Zheng',cursive", 'zhimang': "'Zhi Mang Xing',cursive",
        'liujian': "'Liu Jian Mao Cao',cursive", 'longcang': "'Long Cang',cursive",
      };
      return map[localStorage.getItem('haizhe-font-lyrics') || 'noto-serif'] || "'Noto Serif SC',serif";
    })(),
  };
}

function pipStyles(cfg: ReturnType<typeof readPipCfg>) {
  return [
    'margin:0;padding:12px 20px;',
    `background:rgba(0,0,0,${cfg.bgDark});color:${cfg.color};`,
    `font-size:${cfg.fontSize}px;text-align:center;`,
    'display:flex;align-items:center;justify-content:center;',
    'height:100vh;box-sizing:border-box;',
    `font-family:${cfg.fontFamily};`,
    'letter-spacing:0.03em;user-select:none;',
    '-webkit-app-region:drag;',
  ].join('');
}

async function pipOpen(): Promise<Window | null> {
  if (pipWin && !pipWin.closed) return pipWin;
  try {
    // @ts-expect-error Document Picture-in-Picture API
    pipWin = await documentPictureInPicture.requestWindow({ width: 420, height: 100 });
    const doc = pipWin!.document;
    doc.documentElement.style.background = 'transparent';
    const cfg = readPipCfg();
    doc.body.style.cssText = pipStyles(cfg);
    doc.body.textContent = '♫ 等待歌词...';
    pipWin!.addEventListener('pagehide', () => { pipWin = null; });
    return pipWin;
  } catch { return null; }
}

function pipUpdate(text: string, next: string | undefined) {
  if (!pipWin || pipWin.closed) return;
  const cfg = readPipCfg(); // 每次读取最新设置
  const d = pipWin.document;
  d.body.innerHTML = [
    '<div style="display:flex;flex-direction:column;align-items:center;gap:3px">',
    `<span style="font-weight:600;font-size:${cfg.fontSize}px;color:${cfg.color};text-shadow:0 0 10px ${cfg.color}44">${text || '♪'}</span>`,
    next ? `<span style="font-size:${Math.round(cfg.fontSize*0.8)}px;opacity:0.40;color:${cfg.color}">${next}</span>` : '',
    '</div>'
  ].join('');
  d.body.style.cssText = pipStyles(cfg);
}

function pipClose() { if (pipWin) { pipWin.close(); pipWin = null; } }

/* ── PlayerBar ── */
export function PlayerBar() {
  const { state, dispatch } = usePlayer();
  const { currentSong, isPlaying, currentTime, duration, volume, isMuted, playMode } = state;
  const [fs, setFs] = useState(false);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [lyricLoading, setLyricLoading] = useState(false);
  const [pipOn, setPipOn] = useState(false);

  // 切歌重置
  useEffect(() => { setLyrics(null); }, [currentSong?.id]);

  // 全屏加载歌词
  useEffect(() => {
    if (!fs || !currentSong?.has_lrc) return;
    setLyricLoading(true);
    api.getLyrics(currentSong.id).then(setLyrics).catch(() => setLyrics(null)).finally(() => setLyricLoading(false));
  }, [fs, currentSong?.id]);

  // PiP/桌面歌词更新循环 — 改用全局 timeRef（零渲染开销）
  const songRef = useRef(currentSong);
  songRef.current = currentSong;

  useEffect(() => {
    if (!pipOn) { pipClose(); return; }
    if (!currentSong?.has_lrc) return;

    let cancelled = false;
    let lyricsCache: Lyrics | null = null;
    const isElectron = !!(window as any).electronAPI;

    let cachedCfg = '';
    const tick = async () => {
      if (cancelled) return;
      if (!isElectron && (!pipWin || pipWin.closed)) return;
      const song = songRef.current;
      if (!song?.has_lrc) return;
      try {
        if (!lyricsCache) lyricsCache = await api.getLyrics(song.id);
        const idx = lyricsCache.lines.findLastIndex(l => l.time <= timeRef.current);
        const cur = lyricsCache?.lines[idx] || null;
        const nxt = lyricsCache && idx >= 0 && idx < lyricsCache.lines.length - 1 ? lyricsCache.lines[idx + 1] : null;
        if (isElectron) {
          (window as any).electronAPI.lyricUpdate({ text: cur?.text || '♪', next: nxt?.text || '' });
          // ⚡ 只在配置真正变化时才发送 IPC（避免每 400ms 触发歌词窗口样式重算）
          const cfgStr = JSON.stringify(readPipCfg());
          if (cfgStr !== cachedCfg) {
            cachedCfg = cfgStr;
            (window as any).electronAPI.lyricConfig(readPipCfg());
          }
        } else {
          pipUpdate(cur?.text || '♪', nxt?.text);
        }
      } catch {}
    };

    tick();
    const timer = setInterval(tick, 400);

    return () => { cancelled = true; clearInterval(timer); };
  }, [pipOn, currentSong?.id]); // 移除了 currentTime 依赖



  const togglePip = async () => {
    if (pipOn) {
      setPipOn(false);
      // Electron 模式
      const ea = (window as any).electronAPI;
      if (ea) ea.lyricHide();
      else pipClose();
    } else {
      const ea = (window as any).electronAPI;
      if (ea) {
        ea.lyricShow();
        ea.lyricConfig(readPipCfg());
        setPipOn(true);
      } else {
        const w = await pipOpen();
        if (w) setPipOn(true);
      }
    }
  };

  const onProgress = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = (Number(e.target.value) / 100) * duration;
    dispatch({ type: 'SET_TIME', time: t });
    document.querySelector('audio')!.currentTime = t;
  };

  const modeIcons: Record<string, string> = { sequential: '\u{1F501}', shuffle: '\u{1F500}', repeat: '\u{1F502}', 'repeat-one': '\u{1F502}' };
  const cycleMode = () => {
    const modes: typeof playMode[] = ['sequential', 'shuffle', 'repeat'];
    dispatch({ type: 'SET_MODE', mode: modes[(modes.indexOf(playMode) + 1) % modes.length] });
  };

  if (!currentSong) {

    return (
      <div className="h-16 glass shrink-0 flex items-center justify-center text-white/15 text-sm max-md:h-14">
        {'\u9009\u62E9\u4E00\u9996\u6B4C\u5F00\u59CB\u64AD\u653E \u{1F3B5}'}
      </div>
    );
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <>
      {fs && currentSong && (
        <FSPlayer
          key={currentSong.id}
          song={currentSong} lyrics={lyrics} loading={lyricLoading}
          cur={currentTime} dur={duration} pct={pct} playing={isPlaying}
          vol={volume} modeIcon={modeIcons[playMode] || '\u{1F501}'}
          onClose={() => setFs(false)} onProgress={onProgress}
          onTogglePlay={() => dispatch({ type: 'TOGGLE_PLAY' })}
          onPrev={() => dispatch({ type: 'PREV' })}
          onNext={() => dispatch({ type: 'NEXT' })}
          onVolume={(e) => dispatch({ type: 'SET_VOLUME', volume: Number(e.target.value) / 100 })}
          onToggleMute={() => dispatch({ type: 'TOGGLE_MUTE' })}
          onCycleMode={cycleMode}
        />
      )}

      {/* Bottom bar */}
      <div className="h-18 glass shrink-0 px-4 flex items-center gap-4 relative max-md:h-14 max-md:gap-2 max-md:px-2">
        <div className="absolute top-0 left-0 right-0 -translate-y-1/2 px-0 z-10">
          <input type="range" min={0} max={100} value={pct} onChange={onProgress} className="progress-bar w-full"
            style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.06) ${pct}%)` }} />
        </div>

        <div className="flex items-center gap-3 min-w-[180px] max-w-[260px] max-md:min-w-[100px] max-md:max-w-[140px]">
          <CoverThumbnail songId={currentSong.id} size={42} eager />
          <div className="min-w-0 max-md:hidden">
            <p className="text-sm font-medium truncate">{currentSong.title}</p>
            <p className="text-xs text-white/30 truncate">{currentSong.artist}</p>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center gap-0.5 max-md:gap-0">
          <div className="flex items-center gap-4 max-md:gap-2">
            <button onClick={cycleMode} className="text-white/35 hover:text-white text-xs w-6 text-center">{modeIcons[playMode] || '\u{1F501}'}</button>
            <button onClick={() => dispatch({ type: 'PREV' })} className="text-white/60 hover:text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
            </button>
            <button onClick={() => dispatch({ type: 'TOGGLE_PLAY' })} className="w-9 h-9 rounded-full bg-white flex items-center justify-center hover:scale-105 transition-transform shadow-lg">
              {isPlaying
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="black"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="black" style={{ marginLeft: 1 }}><path d="M8 5v14l11-7z"/></svg>
              }
            </button>
            <button onClick={() => dispatch({ type: 'NEXT' })} className="text-white/60 hover:text-white">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
            <button onClick={() => setFs(true)} className="text-xs px-2 py-1 rounded-full text-white/35 hover:text-white hover:bg-white/5 transition-colors">词</button>
            <button onClick={togglePip}
              className={`text-xs px-2 py-1 rounded-full transition-colors ${pipOn ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'text-white/35 hover:text-white hover:bg-white/5'}`}>
              桌词
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs text-white/20 max-md:hidden">
            <span>{fmt(currentTime)}</span><span>/</span><span>{fmt(duration)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 min-w-[120px] justify-end max-md:min-w-[48px]">
          <button onClick={() => dispatch({ type: 'TOGGLE_MUTE' })} className="text-white/35 hover:text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isMuted || volume === 0
                ? <><path d="M11 5 6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></>
                : <><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></>
              }
            </svg>
          </button>
          <input type="range" min={0} max={100} value={volume * 100}
            onChange={e => dispatch({ type: 'SET_VOLUME', volume: Number(e.target.value) / 100 })}
            className="w-20 progress-bar max-md:hidden"
            style={{ background: `linear-gradient(to right, var(--text-secondary) ${volume * 100}%, rgba(255,255,255,0.06) ${volume * 100}%)` }} />
        </div>
      </div>
    </>
  );
}

/* ═══════════════ 全屏播放（自动滚动歌词居中） ═══════════════ */
function FSPlayer({ song, lyrics, loading, cur, dur, pct, playing, vol, modeIcon,
  onClose, onProgress, onTogglePlay, onPrev, onNext, onVolume, onToggleMute, onCycleMode,
}: {
  song: import('../types').Song; lyrics: Lyrics | null; loading: boolean;
  cur: number; dur: number; pct: number; playing: boolean;
  vol: number; modeIcon: string;
  onClose: () => void; onProgress: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onTogglePlay: () => void; onPrev: () => void; onNext: () => void;
  onVolume: (e: React.ChangeEvent<HTMLInputElement>) => void; onToggleMute: () => void;
  onCycleMode: () => void;
}) {
  const lyrRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLImageElement>(null);
  const userScroll = useRef(false);
  const scrollTO = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeIdx = lyrics ? lyrics.lines.findLastIndex(l => l.time <= cur) : -1;

  // Auto-scroll active line to center
  useEffect(() => {
    if (userScroll.current || !lyrRef.current) return;
    const el = lyrRef.current.querySelector('.lyrics-line.active');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  // Detect user scroll
  const onLyricScroll = () => {
    userScroll.current = true;
    if (scrollTO.current) clearTimeout(scrollTO.current);
    scrollTO.current = setTimeout(() => { userScroll.current = false; }, 3000);

    };

    // V10.2: cleanup scroll timeout + stable lyrics click
    useEffect(() => { return () => { if (scrollTO.current) clearTimeout(scrollTO.current); }; }, []);

    // V10.2: 卸载时清空封面 src → 释放 Chromium 图片缓存中的解码位图
    useEffect(() => { return () => { if (coverRef.current) coverRef.current.src = ''; }; }, []);

    const handleLyricClick = useCallback((e: React.MouseEvent<HTMLParagraphElement>) => {
      const t = parseFloat(e.currentTarget.dataset.time || '0');
      const a = document.querySelector('audio');
      if (a) a.currentTime = t;
    }, []);

  return (
    <div className="fixed inset-0 z-50 player-bg animate-[fi_0.3s] flex flex-col">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <style>{'@keyframes fi{from{opacity:0}to{opacity:1}}'}</style>

      <div className="relative z-10 flex justify-end p-4 shrink-0">
        <button onClick={onClose} className="text-white/30 hover:text-white">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div className="relative z-10 flex-1 flex gap-12 w-full max-w-5xl mx-auto px-8 overflow-hidden max-md:flex-col max-md:gap-4 max-md:px-4">
        <div className="flex-1 flex flex-col items-center justify-center max-md:flex-none max-md:pt-2">
          <div className="relative w-[260px] h-[260px] max-md:w-[160px] max-md:h-[160px] rounded-2xl overflow-hidden shadow-2xl shadow-purple-900/20">
            {/* V10.2: ref + cleanup 确保切歌时清空 src 释放解码位图 */}
            <img ref={coverRef} src={api.coverUrl(song.id, 800)} alt={song.title}
              loading="lazy"
              className={`w-full h-full object-cover transition-transform duration-700 ${playing ? 'scale-105' : 'scale-100'}`}
              onError={e => {
                const t = e.target as HTMLImageElement; t.style.display = 'none';
                const p = t.parentElement!; p.classList.add('flex','items-center','justify-center','bg-gradient-to-br','from-purple-900','to-pink-800');
                /* innerHTML+ removed */
              }} />
          </div>
          <div className="mt-4 text-center max-md:mt-2">
            <h2 className="text-xl font-bold max-md:text-base">{song.title}</h2>
            <p className="text-white/30 text-sm mt-0.5">{song.artist}</p>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0 pb-2 max-md:pb-0 max-md:max-h-[30vh]">
          <div className="text-white/15 text-xs tracking-wider mb-2 shrink-0">歌词</div>
          <div ref={lyrRef} onScroll={onLyricScroll} className="flex-1 overflow-y-auto pr-2 max-md:max-h-[25vh]">
            {loading && <p className="text-white/15 text-sm text-center py-12">加载中...</p>}
            {!loading && !lyrics && <div className="flex flex-col items-center justify-center h-full text-white/10"><p className="text-sm">暂无歌词</p></div>}
            {lyrics && lyrics.lines.map((line, i) => (
              <p key={i}
                className={`lyrics-line py-2 px-3 rounded-lg transition-all duration-300 cursor-pointer ${i === activeIdx ? 'active' : 'inactive'}`}
                data-time={line.time} onClick={handleLyricClick}>
                {line.text || '\u266A'}
              </p>
            ))}
          </div>
        </div>
      </div>

      <div className="relative z-10 shrink-0 bg-black/50 backdrop-blur-xl border-t border-white/5 px-8 py-4 flex flex-col items-center gap-3 max-md:px-4 max-md:py-3">
        <div className="w-full max-w-xl flex items-center gap-3">
          <span className="text-xs text-white/20 w-10 text-right">{fmt(cur)}</span>
          <input type="range" min={0} max={100} value={pct} onChange={onProgress} className="progress-bar flex-1"
            style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,0.08) ${pct}%)` }} />
          <span className="text-xs text-white/20 w-10">{fmt(dur)}</span>
        </div>
        <div className="flex items-center gap-6">
          <button onClick={onCycleMode} className="text-white/25 hover:text-white text-xs w-6 text-center">{modeIcon}</button>
          <button onClick={onPrev} className="text-white/40 hover:text-white"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
          <button onClick={onTogglePlay} className="w-10 h-10 rounded-full bg-white flex items-center justify-center hover:scale-105 transition-transform shadow-lg">
            {playing
              ? <svg width="18" height="18" viewBox="0 0 24 24" fill="black"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="black" style={{ marginLeft: 1 }}><path d="M8 5v14l11-7z"/></svg>
            }
          </button>
          <button onClick={onNext} className="text-white/40 hover:text-white"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>
        </div>
        <div className="flex items-center gap-2 max-md:hidden">
          <button onClick={onToggleMute} className="text-white/25 hover:text-white"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg></button>
          <input type="range" min={0} max={100} value={vol * 100} onChange={onVolume} className="w-20 progress-bar"
            style={{ background: `linear-gradient(to right, var(--text-secondary) ${vol * 100}%, rgba(255,255,255,0.06) ${vol * 100}%)` }} />
        </div>
      </div>
    </div>
  );
}
