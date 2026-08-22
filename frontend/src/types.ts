// 音乐播放器 - TypeScript 类型定义

export interface Song {
  id: string;
  title: string;
  artist: string;
  artists: string[];
  has_cover: boolean;
  has_lrc: boolean;
  duration: number | null;
}

export interface Artist {
  name: string;
  song_count: number;
  cover_song_id: string | null;
}

export interface LyricsLine {
  time: number;
  text: string;
}

export interface Lyrics {
  lines: LyricsLine[];
  ti: string | null;
  ar: string | null;
  al: string | null;
}

export interface SearchResult {
  total: number;
  songs: Song[];
}

export type Stem = 'original' | 'vocals' | 'instrumental';

/** 分离质量：standard=MDX(快) / hq=BS-Roformer(最强，需GPU) */
export type StemQuality = 'standard' | 'hq';

export interface StemStatus {
  available: boolean;   // 后端是否安装 audio-separator
  gpu: boolean;         // 是否有 CUDA GPU 加速
  status: 'none' | 'processing' | 'ready' | 'error';
  progress: number;     // 0-100
  quality?: StemQuality | null;
  error?: string | null;
}

export interface StemItem {
  song_id: string;
  size_mb: number;
  quality?: StemQuality;
}

export interface PlayerState {
  currentSong: Song | null;
  playlist: Song[];
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  playMode: 'sequential' | 'repeat' | 'repeat-one' | 'shuffle';
  lastSongId?: string | null;  // V10: 持久化上次播放的歌
  // V12: 音效（倍速/移调/小黄人）+ 人声分离音轨
  playbackRate: number;
  pitchSemitones: number;
  chipmunk: boolean;
  stem: Stem;
  /** V12.3: 每次切歌/重播自增，驱动 audio src effect 重新加载
   *  （单曲列表播完绕回同首歌时 id/stem 都不变，靠此 token 触发） */
  playToken: number;
}
