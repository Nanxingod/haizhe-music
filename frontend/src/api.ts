// 音乐播放器 - API 客户端

import type { Song, Artist, Lyrics, SearchResult, StemStatus, StemItem, StemQuality } from './types';

// 前后端同域（Vite proxy），直接用相对路径
const BASE = '';

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    throw new Error(`API Error ${res.status}: ${err}`);
  }
  return res.json();
}

export const api = {
  getStatus: () => fetchJSON<{ songs: number; artists: number }>(`${BASE}/api/status`),

  getArtists: () => fetchJSON<Artist[]>(`${BASE}/api/artists`),

  getArtistSongs: (artist: string) =>
    fetchJSON<Song[]>(`${BASE}/api/artists/${encodeURIComponent(artist)}`),

  getSongs: (search = '', limit = 500, offset = 0) =>
    fetchJSON<SearchResult>(
      `${BASE}/api/songs?search=${encodeURIComponent(search)}&limit=${limit}&offset=${offset}`
    ),

  getSong: (id: string) => fetchJSON<Song>(`${BASE}/api/songs/${id}`),

  getLyrics: (id: string) => fetchJSON<Lyrics>(`${BASE}/api/lyrics/${id}`),

  streamUrl: (id: string, stem = '') =>
    `${BASE}/api/stream/${id}${stem && stem !== 'original' ? `?stem=${stem}` : ''}`,

  // V10: 封面分级加载 — 列表用 150px 缩略，全屏用 800px 原图
  coverUrl: (id: string, size = 150) => `${BASE}/api/cover/${id}?size=${size}`,

  // V10: 刷新歌曲库
  refreshSongs: () =>
    fetch(`${BASE}/api/refresh`, { method: 'POST' }).then(r => r.json()),

  // V12: 人声/伴奏分离
  getStems: (id: string) => fetchJSON<StemStatus>(`${BASE}/api/stems/${id}`),

  listStems: () =>
    fetchJSON<{ available: boolean; gpu: boolean; items: StemItem[] }>(`${BASE}/api/stems`),

  separateStems: async (id: string, quality: StemQuality = 'standard'): Promise<StemStatus> => {
    const res = await fetch(`${BASE}/api/stems/${id}/separate?quality=${quality}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Error ${res.status}`);
    return res.json();
  },

  deleteStems: (id: string) =>
    fetch(`${BASE}/api/stems/${id}`, { method: 'DELETE' }).then(r => r.json()),
};
