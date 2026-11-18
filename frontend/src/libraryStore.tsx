// 收藏 / 歌单的前端状态（V14.8）
//
// 为什么用 Provider 而不是每页各自拉：
// 「全部歌曲」「我喜欢」「歌单」三个页面都要显示星星状态，还都要能点星。
// 状态集中在这里 → 点星后所有页面立刻同步，不用各自轮询。

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import type { Playlist } from './types';

interface LibraryCtx {
  favorites: Set<string>;
  playlists: Playlist[];
  loading: boolean;
  refresh: () => Promise<void>;
  toggleFav: (songId: string) => Promise<void>;
  addToPlaylist: (playlistId: string, songId: string) => Promise<void>;
  removeFromPlaylist: (playlistId: string, songId: string) => Promise<void>;
  newPlaylist: (name: string) => Promise<Playlist | null>;
}

const Ctx = createContext<LibraryCtx | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [sum, favList] = await Promise.all([
        api.getLibrary(),
        api.getLibraryList('favorites'),
      ]);
      setPlaylists(sum.playlists);
      setFavorites(new Set(favList.songs.map(s => s.id)));
    } catch {
      /* 后端没起来时静默失败，不影响播放 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const toggleFav = useCallback(async (songId: string) => {
    // 先乐观更新，失败再回滚 —— 点星必须即时，不能等网络
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId); else next.add(songId);
      return next;
    });
    try {
      const r = await api.toggleFavorite(songId);
      setFavorites(prev => {
        const next = new Set(prev);
        if (r.on) next.add(songId); else next.delete(songId);
        return next;
      });
    } catch {
      setFavorites(prev => {
        const next = new Set(prev);
        if (next.has(songId)) next.delete(songId); else next.add(songId);
        return next;
      });
    }
  }, []);

  const syncCounts = useCallback(async () => {
    const sum = await api.getLibrary().catch(() => null);
    if (sum) setPlaylists(sum.playlists);
  }, []);

  const addToPlaylist = useCallback(async (playlistId: string, songId: string) => {
    await api.addToPlaylist(playlistId, songId);
    await syncCounts();
  }, [syncCounts]);

  const removeFromPlaylist = useCallback(async (playlistId: string, songId: string) => {
    await api.removeFromPlaylist(playlistId, songId);
    await syncCounts();
  }, [syncCounts]);

  const newPlaylist = useCallback(async (name: string) => {
    try {
      const pl = await api.createPlaylist(name);
      setPlaylists(prev => [...prev, pl]);
      return pl;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo(
    () => ({ favorites, playlists, loading, refresh, toggleFav, addToPlaylist, removeFromPlaylist, newPlaylist }),
    [favorites, playlists, loading, refresh, toggleFav, addToPlaylist, removeFromPlaylist, newPlaylist],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibrary() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider');
  return ctx;
}
