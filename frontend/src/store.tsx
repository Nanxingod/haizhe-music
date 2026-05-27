// 音乐播放器 - 全局播放器状态管理
// V10：V9 改进 + 播放记忆持久化 + 歌曲删除容错

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
      audio.play().catch(() => {});
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
        audio.play().catch(() => {});
      } else {
        dispatch({ type: 'NEXT' });
      }
    };
    audio.addEventListener('ended', handleEnded);
    return () => audio.removeEventListener('ended', handleEnded);
  }, [state.playMode]);

  // ⚡ V10: 歌曲文件被删除时的容错 — 自动跳下一首
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleError = () => {
      const err = audio.error;
      // MEDIA_ERR_SRC_NOT_SUPPORTED (4) 或网络错误 → 文件可能被删
      if (err && (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === MediaError.MEDIA_ERR_NETWORK)) {
        console.warn('[Player] 歌曲加载失败，跳过:', state.currentSong?.title);
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