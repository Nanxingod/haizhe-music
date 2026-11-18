// 收藏 / 最近播放 / 歌单 三个页面共用一个外壳（V14.8）
//
// 差别只在数据来源和头部按钮：
//   favorites → /api/library/list?type=favorites
//   recent    → type=recent
//   playlist  → type=playlist&id=xxx，额外有重命名/删除

import { memo, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Song } from '../types';
import { api } from '../api';
import { usePlayer } from '../store';
import { useLibrary } from '../libraryStore';
import { SongListContent } from '../components/SongList';

type Kind = 'favorites' | 'recent' | 'playlist';

export const LibraryPage = memo(function LibraryPage({ kind }: { kind: Kind }) {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { play, state } = usePlayer();
  const { refresh: refreshLib, playlists } = useLibrary();

  const [songs, setSongs] = useState<Song[]>([]);
  const [title, setTitle] = useState('');
  const [missing, setMissing] = useState(0);
  const [loading, setLoading] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [nameInput, setNameInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getLibraryList(kind, id);
      setSongs(r.songs);
      setTitle(r.title || '');
      setMissing(r.missing || 0);
    } catch {
      setSongs([]);
    } finally {
      setLoading(false);
    }
  }, [kind, id]);

  useEffect(() => { load(); }, [load]);

  // 歌单被改名/删除后，若当前页正是它，标题要跟着变
  useEffect(() => {
    if (kind !== 'playlist') return;
    const pl = playlists.find(p => p.id === id);
    if (pl) setTitle(pl.name);
  }, [kind, id, playlists]);

  const handlePlay = useCallback((song: Song) => play(song, songs), [play, songs]);
  const playAll = useCallback(() => {
    if (songs.length) play(songs[0], songs);
  }, [play, songs]);

  const doRename = async () => {
    const name = nameInput.trim();
    setRenaming(false);
    if (!name || name === title) return;
    try {
      await api.renamePlaylist(id, name);
      setTitle(name);
      await refreshLib();
    } catch { /* 失败就保持原名 */ }
  };

  const doDelete = async () => {
    if (!window.confirm(`删除歌单「${title}」？歌曲本身不会被删除。`)) return;
    try {
      await api.deletePlaylist(id);
      await refreshLib();
      nav('/');
    } catch { /* ignore */ }
  };

  const empty = !loading && songs.length === 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 pt-5 pb-2 max-md:px-4">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            {renaming ? (
              <input
                autoFocus value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={doRename}
                onKeyDown={e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') setRenaming(false); }}
                className="text-2xl font-bold bg-transparent border-b border-[var(--accent)]/60 outline-none w-full max-w-md"
              />
            ) : (
              <h1 className="text-2xl font-bold max-md:text-xl truncate flex items-center gap-2">
                {title || (kind === 'recent' ? '最近播放' : kind === 'favorites' ? '我喜欢' : '歌单')}
                {kind === 'playlist' && (
                  <button
                    onClick={() => { setNameInput(title); setRenaming(true); }}
                    title="重命名"
                    className="text-white/20 hover:text-white/60 transition-colors shrink-0">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                    </svg>
                  </button>
                )}
              </h1>
            )}
            <p className="text-white/30 text-sm mt-0.5">
              {songs.length} 首
              {missing > 0 && <span className="text-amber-300/50"> · {missing} 首在曲库里已找不到</span>}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {songs.length > 0 && (
              <button onClick={playAll}
                className="px-3.5 py-1.5 rounded-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors">
                播放全部
              </button>
            )}
            {kind === 'playlist' && (
              <button onClick={doDelete}
                className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/35 hover:bg-red-500/15 hover:text-red-300/80 transition-colors">
                删除
              </button>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-8 space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-3">
              <div className="skeleton w-10 h-10 rounded-lg" />
              <div className="flex-1 space-y-2"><div className="skeleton h-4 w-48 rounded" /><div className="skeleton h-3 w-24 rounded" /></div>
            </div>
          ))}
        </div>
      ) : empty ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-white/45">
          {kind === 'recent' ? (
            <>
              <p className="text-sm">还没有播放记录</p>
              <p className="text-[11px] text-white/30">播放几首歌就会按时间出现在这里</p>
            </>
          ) : (
            <>
              <p className="text-sm">这个歌单还没有歌</p>
              <div className="text-[11px] text-white/35 leading-relaxed text-center space-y-1">
                <p>加歌的两个地方：</p>
                <p>① 任意列表里把鼠标移到歌曲行右侧 → 点 <span className="text-white/60">⋯</span> → 勾选这个歌单</p>
                <p>② 底栏正在播放的歌，左侧 <span className="text-white/60">☆</span> 收藏、<span className="text-white/60">⋯</span> 加入歌单</p>
              </div>
              <button onClick={() => nav('/')}
                className="mt-1 px-3.5 py-1.5 rounded-lg text-xs bg-white/5 text-white/50 hover:bg-white/10 hover:text-white transition-colors">
                去全部歌曲
              </button>
            </>
          )}
        </div>
      ) : (
        <SongListContent
          songs={songs}
          currentSongId={state.currentSong?.id}
          isPlaying={state.isPlaying}
          onPlay={handlePlay}
          grouped={false}
        />
      )}
    </div>
  );
});
