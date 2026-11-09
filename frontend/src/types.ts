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

/** 分离质量：standard=MDX23C(CPU快) / hq=BS PolarFormer(最新，需GPU+setup脚本) */
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

/** V13: 相关视频检索（现场版 / 翻唱 / MV） */
export type RelinkSource = 'bilibili' | 'douyin';
export type RelinkCat = 'live' | 'cover' | 'mv' | 'other';
/** 结果来自哪：network=刚搜的，memory=进程内缓存，disk=本地磁盘缓存 */
export type RelinkOrigin = 'network' | 'memory' | 'disk';

export interface RelinkItem {
  title: string;
  url: string;
  source: RelinkSource;
  source_label: string;
  author: string;
  play: number;
  duration: string;
  /** AI 写的一句话短评，规则排序时为空 */
  blurb: string;
  score: number;
}

export interface RelinkGroup {
  key: RelinkCat;
  label: string;
  items: RelinkItem[];
}

export interface RelinkResult {
  song: { id: string; title: string; artist: string };
  /** 是否用了 DeepSeek 归类打分 */
  ai: boolean;
  /** true = 抖音/AI 还在后台补，稍后轮询 */
  pending: boolean;
  /** 结果来源：network / memory / disk */
  source: RelinkOrigin;
  total: number;
  groups: RelinkGroup[];
  notes: string[];
  took_ms: number;
  /** 这份结果是什么时候搜出来的（unix 秒） */
  fetched_at: number;
}

export interface RelinkConfig {
  /** DeepSeek key：同时支撑 AI 归类 与 抖音搜索（DeepSeek Search） */
  deepseek: boolean;
  /** 搜索能力（= 有 DeepSeek key） */
  search: boolean;
  /** Tavily key：仅作抖音的备用通道，可选 */
  tavily: boolean;
}

/** V13.5: 歌手简介（网易云公开接口） */
export interface ArtistInfo {
  found: boolean;
  name: string;
  alias: string[];
  avatar: string;
  /** 中文简介，可能为空（源数据质量差时后端会判为无效） */
  brief: string;
  /** 简介来源：api=网易云原文，ai=DeepSeek 补写，''=无 */
  brief_source: string;
  music_count: number;
  album_count: number;
  fans: number;
  source: string;
  fetched_at: number;
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
   *   （单曲列表播完绕回同首歌时 id/stem 都不变，靠此 token 触发） */
  playToken: number;
  /** V13: 整曲库缓存，作为 shuffle 模式的随机池（NEXT 始终从全库随机，而非当前子集） */
  allSongs: Song[];
  /** V13: shuffle 模式下记住"上一首"，PREV 回退到它（一首回退空间，再往上是随机） */
  shufflePrevId: string | null;
}

/** V14: 旋律（人声轨音高提取） */
export interface MelodyNote {
  /** 起始秒 */
  t: number;
  /** 时长秒 */
  d: number;
  /** MIDI 音高（69=A4） */
  midi: number;
  /** 音名，如 A4 / F#4 */
  note: string;
  /** 相对十二平均律的音分偏差 */
  cents: number;
}

export interface MelodyLine {
  t: number;
  end: number;
  text: string;
  notes: MelodyNote[];
}

export interface MelodyData {
  /** ok / no_vocals / error */
  status: 'ok' | 'no_vocals' | 'error';
  message?: string;
  /** crepe/cuda 或 pyin */
  method?: string;
  duration?: number;
  fps?: number;
  notes: MelodyNote[];
  lines: MelodyLine[];
  took_ms?: number;
  cached: boolean;
  has_vocals: boolean;
}
