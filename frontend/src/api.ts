// 音乐播放器 - API 客户端

import type { Song, Artist, Lyrics, SearchResult, StemStatus, StemItem, StemQuality, RelinkResult, ArtistInfo, MelodyData, LibrarySummary, LibraryList, InsightsState, InsightPick } from './types';

// ⚡ V13.2: Electron 桌面端直连后端，不再依赖 Vite 的 proxy。
// 起因是一次真实故障：Vite(5173) 进程意外退出后，渲染进程所有 /api 请求全部
// "Failed to fetch"、<audio> 也拉不到流 —— 界面还开着但音乐不播，看着像死机。
// 桌面端页面本来就在本机，直连 127.0.0.1:8765 最稳；后端 CORS 允许所有来源。
// 网页版（含手机同 WiFi 访问）仍走相对路径，由 Vite proxy 转发到后端。
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;
export const API_BASE = isElectron ? 'http://127.0.0.1:8765' : '';
const BASE = API_BASE;

async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) {
    // FastAPI 的报错在 {"detail": "..."} 里；直接抛整段 JSON 用户看不懂
    const raw = await res.text().catch(() => '');
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      msg = j.detail || j.message || raw;
    } catch { /* 不是 JSON 就用原文 */ }
    throw new Error(msg || `请求失败 (${res.status})`);
  }
  return res.json();
}

async function postJSON<T>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    throw new Error(`API Error ${res.status}: ${err}`);
  }
  return res.json();
}

export const api = {
  getStatus: () => fetchJSON<{ songs: number; artists: number }>(`${BASE}/api/status`),

  getConfig: () => fetchJSON<{ music_dir: string; relink: { deepseek: boolean; tavily: boolean; search: boolean } }>(`${BASE}/api/config`),

  /** 切换曲库（会同步写 config.json 并全量重扫，冷扫约 7-14 秒） */
  setMusicDir: (dir: string) =>
    postJSON<{ music_dir: string; songs: number; artists: number }>(`${BASE}/api/config`, { music_dir: dir }),

  getArtists: () => fetchJSON<Artist[]>(`${BASE}/api/artists`),

  getArtistSongs: (artist: string) =>
    fetchJSON<Song[]>(`${BASE}/api/artists/${encodeURIComponent(artist)}`),

  getSongs: (search = '', limit = 500, offset = 0) =>
    fetchJSON<SearchResult>(
      `${BASE}/api/songs?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`
    ),

  getSong: (id: string) => fetchJSON<Song>(`${BASE}/api/songs/${id}`),

  // V13.5: 歌手简介（网易云公开接口）
  getArtistInfo: (name: string, refresh = false) =>
    fetchJSON<ArtistInfo>(
      `${BASE}/api/artist-info?name=${encodeURIComponent(name)}${refresh ? '&refresh=1' : ''}`),

  getLyrics: (id: string) => fetchJSON<Lyrics>(`${BASE}/api/lyrics/${id}`),

  streamUrl: (id: string, stem = '') =>
    `${BASE}/api/stream/${id}${stem && stem !== 'original' ? `?stem=${stem}` : ''}`,

  // V10: 封面分级加载 — 列表用 150px 缩略，全屏用 800px 原图
  coverUrl: (id: string, size = 150) => `${BASE}/api/cover/${id}?size=${size}`,

  // V10: 刷新歌曲库
  refreshSongs: () =>
    fetch(`${BASE}/api/refresh`, { method: 'POST' }).then(r => r.json()),

  // V15: 可选依赖（能力探测 + 按需安装）
  getDeps: () => fetchJSON<any>(`${BASE}/api/deps`),
  installDep: (feature: string) => postJSON<{ started: boolean }>(`${BASE}/api/deps/install`, { feature }),
  getDepJob: () => fetchJSON<any>(`${BASE}/api/deps/job`),

  // V15: 歌词补齐（备用，只补缺失）
  lyricsMissing: () =>
    fetchJSON<{ count: number; songs: { id: string; title: string; artist: string }[] }>(`${BASE}/api/lyrics/missing`),

  fetchMissingLyrics: (limit = 20) =>
    postJSON<{ checked: number; filled: number; remaining: number; results: any[] }>(
      `${BASE}/api/lyrics/fetch-missing`, { limit }),

  // V15.3: 曲库画像
  getInsights: () => fetchJSON<InsightsState>(`${BASE}/api/insights`),

  /** 启动分析（后台分批）。limit>0 仅用于调试 */
  analyzeInsights: (limit = 0) =>
    postJSON<{ started: boolean; already?: boolean }>(`${BASE}/api/insights/analyze`, { limit }),

  /** 换一批「可能想听」：LLM + 网易云校验，约 10-30 秒 */
  recommendInsights: (count = 8) =>
    postJSON<{ generated_at: number; theme: string; items: InsightPick[] }>(
      `${BASE}/api/insights/recommend`, { count }),

  // V14.8: 收藏 / 歌单 / 最近播放
  getLibrary: () => fetchJSON<LibrarySummary>(`${BASE}/api/library`),

  getLibraryList: (type: 'favorites' | 'recent' | 'playlist', id = '') =>
    fetchJSON<LibraryList>(`${BASE}/api/library/list?type=${type}${id ? `&id=${encodeURIComponent(id)}` : ''}`),

  toggleFavorite: (songId: string) =>
    postJSON<{ on: boolean }>(`${BASE}/api/library/favorite`, { song_id: songId }),

  createPlaylist: (name: string) =>
    postJSON<{ id: string; name: string; count: number }>(`${BASE}/api/library/playlist`, { name }),

  renamePlaylist: (id: string, name: string) =>
    postJSON<{ ok: boolean }>(`${BASE}/api/library/playlist/${id}`, { name }, 'PATCH'),

  deletePlaylist: (id: string) =>
    postJSON<{ ok: boolean }>(`${BASE}/api/library/playlist/${id}`, undefined, 'DELETE'),

  songPlaylists: (songId: string) =>
    fetchJSON<{ playlists: string[]; favorite: boolean }>(`${BASE}/api/library/song/${songId}`),

  addToPlaylist: (id: string, songId: string) =>
    postJSON<{ on: boolean }>(`${BASE}/api/library/playlist/${id}/add`, { song_id: songId }),

  removeFromPlaylist: (id: string, songId: string) =>
    postJSON<{ on: boolean }>(`${BASE}/api/library/playlist/${id}/remove`, { song_id: songId }),

  toggleInPlaylist: (id: string, songId: string) =>
    postJSON<{ on: boolean }>(`${BASE}/api/library/playlist/${id}/toggle`, { song_id: songId }),

  recordPlay: (songId: string) =>
    postJSON<{ ok: boolean }>(`${BASE}/api/library/play`, { song_id: songId }),

  // V12: 人声/伴奏分离
  getStems: (id: string) => fetchJSON<StemStatus>(`${BASE}/api/stems/${id}`),

  /** 下载高质量分离模型（PolarFormer 102MB，脚本幂等） */
  prepareHqModel: () =>
    postJSON<{ started: boolean; already?: boolean }>(`${BASE}/api/stems/prepare-hq`, {}),
  getHqJob: () =>
    fetchJSON<{ running: boolean; done: boolean; ok: boolean; error: string; log: string[] }>(
      `${BASE}/api/stems/prepare-hq/job`),

  listStems: () =>
    fetchJSON<{ available: boolean; gpu: boolean; items: StemItem[] }>(`${BASE}/api/stems`),

  separateStems: async (id: string, quality: StemQuality = 'standard'): Promise<StemStatus> => {
    const res = await fetch(`${BASE}/api/stems/${id}/separate?quality=${quality}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Error ${res.status}`);
    return res.json();
  },

  deleteStems: (id: string) =>
    fetch(`${BASE}/api/stems/${id}`, { method: 'DELETE' }).then(r => r.json()),

  // V13: 相关视频检索（现场版/翻唱）
  // signal 用于超时中断：后端补齐阶段可能被慢查询占住，不能无限等
  getRelinks: (id: string, refresh = false, signal?: AbortSignal) =>
    fetchJSON<RelinkResult>(`${BASE}/api/relinks/${id}${refresh ? '?refresh=1' : ''}`, signal),

  /** 旋律：人声轨音高提取（首次约 20 秒，之后走缓存） */
  getMelody: (id: string, refresh = false) =>
    fetchJSON<MelodyData>(`${BASE}/api/melody/${id}${refresh ? '?refresh=1' : ''}`),

  /** 歌手维度的相关视频（现场/翻唱/MV） */
  getArtistRelinks: (name: string, refresh = false, signal?: AbortSignal) =>
    fetchJSON<RelinkResult>(
      `${BASE}/api/artist-relinks?name=${encodeURIComponent(name)}${refresh ? '&refresh=1' : ''}`,
      signal),

  /** 保存检索用的 key（deepseek / tavily） */
  saveRelinkKeys: (body: { deepseek_api_key?: string; tavily_api_key?: string }) =>
    fetch(`${BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Error ${r.status}`);
      return r.json();
    }),
};
