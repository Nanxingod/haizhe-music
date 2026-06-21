// 音乐播放器 - 全局播放器状态管理
// V10.3：V10.2 + 切歌 play() 恢复 + waiting 超时 + ended 防御

import { createContext, useContext, useReducer, useRef, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import type { Song, PlayerState } from './types';
import { api } from './api';

type Action =
  | { type: 'SET_SONG'; song: Song }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TOGGLE_PLAY' }
  | { type: 'SET_TIME'; time: number }
  | { type: 'SET_DURATION'; duration: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'SET_PLAYLIST'; playlist: Song[]; startIndex?: number }
  | { type: 'NEXT' }
  | { type: 'PREV' }
  | { type: 'SET_MODE'; mode: PlayerState['playMode'] };

// ⚡ 高频值全局 ref — 供 PlayerBar 的 PiP tick / 歌词滚动读取，跳过 React 渲染链路
export const timeRef = { current: 0 };
export const durRef = { current: 0 };

// ⚡ 持久化读取：音量、播放模式、上次播放歌曲 ID
function loadPersistedState() {
  let playMode: PlayerState['playMode'] = 'sequential';
  let lastSongId: string | null = null;
  try {
    const saved = localStorage.getItem('haizhe-player');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.playMode) playMode = parsed.playMode;
      if (parsed.lastSongId) lastSongId = parsed.lastSongId;
    }
  } catch {}
  return { playMode, lastSongId };
}

const persisted = loadPersistedState();

const initialState: PlayerState = {
  currentSong: null,
  playlist: [],
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: (() => { try { return Number(localStorage.getItem('haizhe-volume')) || 0.3; } catch { return 0.3; } })(),
  isMuted: false,
  playMode: persisted.playMode,
  lastSongId: persisted.lastSongId,
};

function reducer(state: PlayerState, action: Action): PlayerState {
  switch (action.type) {
    case 'SET_SONG':
      return { ...state, currentSong: action.song, isPlaying: false, currentTime: 0, duration: action.song.duration || 0 };
    case 'PLAY':
      return { ...state, isPlaying: true };
    case 'PAUSE':
      return { ...state, isPlaying: false };
    case 'TOGGLE_PLAY':
      return { ...state, isPlaying: !state.isPlaying };
    case 'SET_TIME':
      return { ...state, currentTime: action.time };
    case 'SET_DURATION':
      return { ...state, duration: action.duration };
    case 'SET_VOLUME':
      return { ...state, volume: action.volume, isMuted: false };
    case 'TOGGLE_MUTE':
      return { ...state, isMuted: !state.isMuted };
    case 'SET_PLAYLIST':
      return {
        ...state,
        playlist: action.playlist,
        currentSong: action.playlist[action.startIndex ?? 0] || state.currentSong,
        isPlaying: false,
        currentTime: 0,
      };
    case 'SET_MODE':
      return { ...state, playMode: action.mode };
    case 'NEXT': {
      if (!state.currentSong || state.playlist.length === 0) return state;
      const idx = state.playlist.findIndex((s: Song) => s.id === state.currentSong!.id);
      const nextIdx = state.playMode === 'shuffle'
        ? Math.floor(Math.random() * state.playlist.length)
        : (idx + 1) % state.playlist.length;
      return {
        ...state,
        currentSong: state.playlist[nextIdx] || state.currentSong,
        currentTime: 0,
      };
    }
    case 'PREV': {
      if (!state.currentSong || state.playlist.length === 0) return state;
      const idx = state.playlist.findIndex((s: Song) => s.id === state.currentSong!.id);
      const prevIdx = (idx - 1 + state.playlist.length) % state.playlist.length;
      return {
        ...state,
        currentSong: state.playlist[prevIdx] || state.currentSong,
        currentTime: 0,
      };
    }
    default:
      return state;
  }
}

interface PlayerContextType {
  state: PlayerState;
  dispatch: React.Dispatch<Action>;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  play: (song: Song, playlist?: Song[]) => void;
  playArtist: (songs: Song[], startIndex?: number) => void;
}

const PlayerContext = createContext<PlayerContextType | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ⚡ 节流：timeupdate 原生 ~4x/s，仅每 500ms 触发一次 React dispatch
  const lastTimeDispatch = useRef(0);
  const TIME_THROTTLE_MS = 500;

  const handleTimeUpdate = useCallback((e: React.SyntheticEvent<HTMLAudioElement>) => {
    const t = e.currentTarget.currentTime;
    timeRef.current = t;
    const now = performance.now();
    if (now - lastTimeDispatch.current >= TIME_THROTTLE_MS) {
      lastTimeDispatch.current = now;
      dispatch({ type: 'SET_TIME', time: t });
    }
  }, []);

  const handleDurationChange = useCallback((e: React.SyntheticEvent<HTMLAudioElement>) => {
    const d = e.currentTarget.duration;
    durRef.current = d;
    if (isFinite(d)) dispatch({ type: 'SET_DURATION', duration: d });
  }, []);

  // 🔥 冷启动预热：应用加载时建立后端连接 + 初始化音频管线
  useEffect(() => {
    const warmup = async () => {
      try {
        const { songs } = await api.getSongs('', 1);
        if (!songs.length) return;
        const audio = new Audio();
        audio.preload = 'auto';
        audio.volume = 0;
        audio.muted = true;
        audio.src = api.streamUrl(songs[0].id);
        audio.load();
        await new Promise<void>((resolve) => {
          audio.addEventListener('canplay', () => resolve(), { once: true });
          setTimeout(resolve, 3000);
        });
        audio.remove();
        audio.src = ''; // 彻底释放
        console.log('[Warmup] 音频管线预热完成');
      } catch { /* 预热失败不影响使用 */ }
    };
    warmup();
  }, []);

  // Update audio element when song changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !state.currentSong) return;

    // V10.1: 标准 src 切换（设 '' 自动 abort + 释放旧解码缓冲）
    audio.pause();
    audio.src = '';
    audio.src = api.streamUrl(state.currentSong.id);

    if (state.isPlaying) {
      // V10.3: play() 在 src 刚设置时数据尚未到达，大部分情况能瞬间就绪
      // 但偶尔（GC/CPU 繁忙/网络抖动）play() 会失败且无恢复机制 → 静默卡死
      // 解决：play() 失败时等待 canplay 再重试
      let cleaned = false;
      audio.play().catch(() => {
        if (cleaned) return;
        const onCanPlay = () => {
          if (!cleaned) audio.play().catch(() => {});
        };
        audio.addEventListener('canplay', onCanPlay, { once: true });
      });
      return () => { cleaned = true; };
    }
  }, [state.currentSong?.id]);

  // Sync play/pause（等音频就绪再播，避免首播延迟）
  // V9: 修复 canplay 监听器泄漏 — 暂停时清理未触发的监听器
  const canplayHandlerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // ⚡ 先清理上一次可能残留的 canplay 监听器
    if (canplayHandlerRef.current) {
      audio.removeEventListener('canplay', canplayHandlerRef.current);
      canplayHandlerRef.current = null;
    }

    if (state.isPlaying) {
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        audio.play().catch(() => {});
      } else {
        const onReady = () => {
          audio.play().catch(() => {});
          audio.removeEventListener('canplay', onReady);
          canplayHandlerRef.current = null;
        };
        canplayHandlerRef.current = onReady;
        audio.addEventListener('canplay', onReady);
      }
    } else {
      audio.pause();
      // ⚡ 暂停时回收音频资源，释放解码缓冲
      if (audio.src && audio.src !== '') {
        // 不立即清空 src（避免切歌闪烁），但暂停解码
        // Chromium 暂停后会自动减少内存占用
      }
    }

    return () => {
      // 组件卸载或 isPlaying 变化时清理监听器
      if (canplayHandlerRef.current) {
        audio.removeEventListener('canplay', canplayHandlerRef.current);
        canplayHandlerRef.current = null;
      }
    };
  }, [state.isPlaying]);

  // Sync volume（同时记忆到 localStorage）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = state.isMuted ? 0 : state.volume;
    localStorage.setItem('haizhe-volume', String(state.volume));
  }, [state.volume, state.isMuted]);


  // ⚡ V10: 持久化辅助函数 — 必须在所有依赖它的 effect 之前定义
  const persistPlayerState = useCallback((mode: string, songId: string | undefined) => {
    try {
      localStorage.setItem("haizhe-player", JSON.stringify({
        playMode: mode,
        lastSongId: songId || null,
      }));
    } catch {}
  }, []);

  // ⚡ V10: 播放模式变化时持久化
  useEffect(() => {
    persistPlayerState(state.playMode, state.currentSong?.id);
  }, [state.playMode, state.currentSong?.id, persistPlayerState]);

  // ⚡ V10: 启动时恢复上次播放的歌曲（不自动播放）
  useEffect(() => {
    const lastId = persisted.lastSongId;
    if (!lastId) return;
    let cancelled = false;
    // 等后端就绪后取歌曲信息
    const restore = async () => {
      try {
        // 同时取歌曲详情 + 全部列表，确保 playlist 不为空、上下曲可用
        const [song, songList] = await Promise.all([
          api.getSong(lastId),
          api.getSongs('', 1000),
        ]);
        if (!cancelled && song && songList.songs.length > 0) {
          const idx = songList.songs.findIndex((s: { id: string }) => s.id === song.id);
          dispatch({ type: 'SET_PLAYLIST', playlist: songList.songs, startIndex: idx >= 0 ? idx : 0 });
        }
      } catch {
        // 歌曲已被删除或不存在，清除记忆
        localStorage.removeItem('haizhe-player');
      }
    };
    // 给后端 2 秒启动时间
    const timer = setTimeout(restore, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // Handle track ended
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleEnded = () => {
      if (state.playMode === 'repeat-one') {
        audio.currentTime = 0;
        // V10.3: 防御性 canplay 重试，防止极罕见情况下 seek 后数据未就绪
        audio.play().catch(() => {
          const onReady = () => {
            audio.play().catch(() => {});
          };
          audio.addEventListener('canplay', onReady, { once: true });
        });
      } else {
        dispatch({ type: 'NEXT' });
      }
    };
    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [state.playMode]);

  // ⚡ V10.2: 错误跳歌防御 — 防止后端重启等场景触发无限切歌死循环
  const errorSkipCount = useRef(0);
  const errorCooldownRef = useRef(false);
  const MAX_CONSECUTIVE_SKIPS = 3;
  const ERROR_COOLDOWN_MS = 2000;  // 两次自动跳歌之间至少 2 秒

  // 成功开始播放时重置错误计数（说明后端已恢复）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onCanPlay = () => {
      errorSkipCount.current = 0;
      errorCooldownRef.current = false;
    };
    audio.addEventListener('canplay', onCanPlay);
    return () => audio.removeEventListener('canplay', onCanPlay);
  }, []);

  // ⚡ V10.2: 音频卡死检测（stalled 事件 + 10 秒超时）
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !state.isPlaying) return;

    let stallTimer: ReturnType<typeof setTimeout> | null = null;

    const handleStalled = () => {
      // 浏览器解码/缓冲卡住时触发 stalled，给 10 秒恢复时间
      stallTimer = setTimeout(() => {
        const a = audioRef.current;
        // 如果 10 秒后 still paused/ended/error，说明彻底卡死了
        if (a && a.paused && !a.ended && !a.error && state.isPlaying) {
          console.warn('[Player] 音频卡死超过 10 秒，尝试跳下一首');
          errorSkipCount.current++;
          if (errorSkipCount.current <= MAX_CONSECUTIVE_SKIPS) {
            dispatch({ type: 'NEXT' });
          } else {
            console.warn('[Player] 连续卡死过多，停止自动跳歌');
          }
        }
      }, 10000);
    };

    const clearStall = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };

    audio.addEventListener('stalled', handleStalled);
    audio.addEventListener('playing', clearStall);
    audio.addEventListener('canplay', clearStall);

    return () => {
      clearStall();
      audio.removeEventListener('stalled', handleStalled);
      audio.removeEventListener('playing', clearStall);
      audio.removeEventListener('canplay', clearStall);
    };
  }, [state.isPlaying, state.currentSong?.id]);

  // ⚡ V10.3: 等待数据超时检测 — 补充 stalled 未覆盖的场景
  // waiting 在缓冲不足时频繁触发，stalled 只在完全卡死时触发
  // 两者都需要超时保护，防止播放器停在无声状态
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !state.isPlaying) return;

    let waitTimer: ReturnType<typeof setTimeout> | null = null;

    const handleWaiting = () => {
      // 缓冲不足暂停播放，给 15 秒加载时间
      waitTimer = setTimeout(() => {
        const a = audioRef.current;
        if (a && a.paused && !a.ended && !a.error && state.isPlaying) {
          console.warn('[Player] 缓冲等待超时 15 秒，尝试跳下一首');
          errorSkipCount.current++;
          if (errorSkipCount.current <= MAX_CONSECUTIVE_SKIPS) {
            dispatch({ type: 'NEXT' });
          } else {
            console.warn('[Player] 连续等待超时过多，停止自动跳歌');
          }
        }
      }, 15000);
    };

    const clearWait = () => {
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
    };

    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('playing', clearWait);
    audio.addEventListener('canplay', clearWait);
    audio.addEventListener('pause', clearWait);

    return () => {
      clearWait();
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('playing', clearWait);
      audio.removeEventListener('canplay', clearWait);
      audio.removeEventListener('pause', clearWait);
    };
  }, [state.isPlaying, state.currentSong?.id]);

  // ⚡ V10.2: 歌曲错误容错 — 带防御的自动跳下一首
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleError = () => {
      const err = audio.error;
      if (!err) return;

      const errorNames: Record<number, string> = {
        [MediaError.MEDIA_ERR_ABORTED]: 'ABORTED',
        [MediaError.MEDIA_ERR_NETWORK]: 'NETWORK',
        [MediaError.MEDIA_ERR_DECODE]: 'DECODE',
        [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'SRC_NOT_SUPPORTED',
      };
      console.warn(`[Player] 播放错误 [${errorNames[err.code] || err.code}]: ${state.currentSong?.title}`);

      // 冷却检查：防止短时间内反复跳歌
      if (errorCooldownRef.current) {
        console.warn('[Player] 冷却中，忽略本次错误');
        return;
      }

      errorSkipCount.current++;
      if (errorSkipCount.current > MAX_CONSECUTIVE_SKIPS) {
        console.warn(`[Player] 连续 ${MAX_CONSECUTIVE_SKIPS}+ 次错误，停止自动跳歌。可能后端异常，请检查。`);
        dispatch({ type: 'PAUSE' });
        return;
      }

      // MEDIA_ERR_NETWORK (2): 网络/后端问题 → 跳下一首
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4): 文件损坏/格式不支持 → 跳下一首
      // MEDIA_ERR_DECODE (3): 解码错误（文件损坏）→ 也跳过
      if (err.code === MediaError.MEDIA_ERR_NETWORK
          || err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
          || err.code === MediaError.MEDIA_ERR_DECODE) {
        console.warn(`[Player] 自动跳过 (第 ${errorSkipCount.current}/${MAX_CONSECUTIVE_SKIPS} 次)`);
        errorCooldownRef.current = true;
        setTimeout(() => { errorCooldownRef.current = false; }, ERROR_COOLDOWN_MS);
        dispatch({ type: 'NEXT' });
      }
    };
    audio.addEventListener('error', handleError);
    return () => audio.removeEventListener('error', handleError);
  }, [state.currentSong?.id, state.playlist]);


  const play = useCallback((song: Song, playlist?: Song[]) => {
    if (playlist) dispatch({ type: 'SET_PLAYLIST', playlist, startIndex: playlist.findIndex(s => s.id === song.id) });
    else dispatch({ type: 'SET_SONG', song });
    dispatch({ type: 'PLAY' });
    // V10: 记住最后播放的歌
    persistPlayerState(state.playMode, song.id);
  }, [state.playMode, persistPlayerState]);

  const playArtist = useCallback((songs: Song[], startIndex = 0) => {
    dispatch({ type: 'SET_PLAYLIST', playlist: songs, startIndex });
    dispatch({ type: 'PLAY' });
    // V10: 记住最后播放的歌
    if (songs[startIndex]) persistPlayerState(state.playMode, songs[startIndex].id);
  }, [state.playMode, persistPlayerState]);

  // ⚡ useMemo 稳定 context value，防止每次渲染生成新对象导致消费者全量重渲染
  const ctxValue = useMemo(() => ({ state, dispatch, audioRef, play, playArtist }), [state, dispatch, play, playArtist]);

  return (
    <PlayerContext.Provider value={ctxValue}>
      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onDurationChange={handleDurationChange}
        onLoadedMetadata={handleDurationChange}
        preload="auto"
        style={{ display: 'none' }}
      />
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}