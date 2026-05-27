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
}
