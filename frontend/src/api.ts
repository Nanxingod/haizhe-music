// 音乐播放器 - API 客户端

import type { Song, Artist, Lyrics, SearchResult, StemStatus, StemItem, StemQuality, RelinkResult, ArtistInfo, MelodyData } from './types';

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
