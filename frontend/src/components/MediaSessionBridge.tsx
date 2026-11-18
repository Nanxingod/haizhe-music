// 系统媒体控制（V14.7）
//
// 用 Web 标准的 MediaSession：Chromium 在 Windows 上会自动把它接到 SMTC
// （音量条 / 锁屏那个"正在播放"卡片），媒体键也由**系统**按"当前活动媒体会话"路由，
// 所以不需要 globalShortcut 去全局抢按键，也不会和 Spotify 之类互相打架。
//
// 覆盖的设备：
//   耳机线控 / 蓝牙耳机的播放暂停键、上一首下一首  → 走媒体键 → 这里
//   键盘上的 ⏯ ⏭ ⏮ 键                            → 同上
//   Windows 音量条里的播放卡片                     → 直接调这里
//   （耳机上的音量 +/- 属于系统音量，本来就能用，与本模块无关）

import { useEffect, useRef } from 'react';
import { usePlayer } from '../store';
import { api } from '../api';

const ACTIONS = [
  'play', 'pause', 'stop', 'previoustrack', 'nexttrack',
  'seekbackward', 'seekforward', 'seekto',
] as const;

export function MediaSessionBridge() {
  const { state, dispatch, audioRef } = usePlayer();
  const { currentSong, isPlaying, duration, playbackRate } = state;

  // handler 只注册一次，但里面要读最新值 → 用 ref 兜住，避免每次 state 变化都重注册
  const live = useRef({ state, dispatch, audioRef });
  live.current = { state, dispatch, audioRef };

  const ms: any = typeof navigator !== 'undefined' ? (navigator as any).mediaSession : null;

  // ① 元数据：歌名 / 歌手 / 封面（SMTC 卡片上显示的就是这些）
  useEffect(() => {
    if (!ms || typeof MediaMetadata === 'undefined') return;
    if (!currentSong) { ms.metadata = null; return; }
    // 传多档尺寸，系统按需要挑（96/192/384 用同一个封面接口，后端会缩放）
    const artwork = currentSong.has_cover
      ? [96, 192, 384].map(s => ({
          src: api.coverUrl(currentSong.id, s),
          sizes: `${s}x${s}`,
          type: 'image/jpeg',
        }))
      : [];
    try {
      ms.metadata = new MediaMetadata({
        title: currentSong.title,
        artist: currentSong.artist,
        artwork,
      });
    } catch { /* 老版本不支持就直接跳过 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, currentSong?.id]);

  // ② 播放状态（'none' 会让系统把卡片撤掉，避免暂停后一直挂着旧歌）
  useEffect(() => {
    if (!ms) return;
    ms.playbackState = !currentSong ? 'none' : isPlaying ? 'playing' : 'paused';
  }, [ms, currentSong?.id, isPlaying]);

  // ③ 进度：锁屏/音量条上的进度条靠它，系统会自己按 playbackRate 走，不用每帧喂
  useEffect(() => {
    if (!ms || typeof ms.setPositionState !== 'function') return;
    const d = duration || currentSong?.duration || 0;
    if (!d || !isFinite(d) || d <= 0) return;
    try {
      const pos = Math.min(Math.max(state.currentTime || 0, 0), d);
      ms.setPositionState({ duration: d, playbackRate: playbackRate || 1, position: pos });
    } catch { /* 参数不合法时忽略即可，不影响播放 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, currentSong?.id, duration, isPlaying, playbackRate]);

  // ④ 按键：播放/暂停/切歌/快进快退
  useEffect(() => {
    if (!ms) return;

    const seekTo = (t: number) => {
      const { audioRef: ar, dispatch: dp } = live.current;
      const a = ar.current;
      if (!a || !isFinite(t)) return;
      const total = isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
      a.currentTime = Math.max(0, Math.min(t, total ? total - 0.2 : t));
      dp({ type: 'SET_TIME', time: a.currentTime });
    };
    const seekBy = (delta: number) => {
      const a = live.current.audioRef.current;
      seekTo((a?.currentTime || 0) + delta);
    };

    try {
      ms.setActionHandler('play', () => live.current.dispatch({ type: 'PLAY' }));
      ms.setActionHandler('pause', () => live.current.dispatch({ type: 'PAUSE' }));
      ms.setActionHandler('stop', () => live.current.dispatch({ type: 'PAUSE' }));
      ms.setActionHandler('previoustrack', () => live.current.dispatch({ type: 'PREV' }));
      ms.setActionHandler('nexttrack', () => live.current.dispatch({ type: 'NEXT' }));
      ms.setActionHandler('seekbackward', (d: any) => seekBy(-(d?.seekOffset ?? 10)));
      ms.setActionHandler('seekforward', (d: any) => seekBy(d?.seekOffset ?? 10));
      ms.setActionHandler('seekto', (d: any) => { if (d?.seekTime != null) seekTo(d.seekTime); });
    } catch { /* 个别 action 不被支持时忽略 */ }

    return () => {
      for (const a of ACTIONS) {
        try { ms.setActionHandler(a, null); } catch { /* ignore */ }
      }
    };
  }, [ms]);

  return null;
}
