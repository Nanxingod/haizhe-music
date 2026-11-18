// 歌曲操作菜单（收藏 / 加入歌单）—— 列表行和底栏共用（V14.8）
//
// 设计要点（第一版踩过的坑）：
// 1. 加歌单用**显式 add / remove**，不用 toggle —— 之前点一下加、菜单随即关闭、
//    没有任何反馈，很容易以为没成功再点一次，结果又移除了（歌单永远是空的）。
// 2. 菜单点完**不关闭**，勾选状态立刻可见；想关点外面。
// 3. 打开时先查「这首歌已经在哪些歌单里」，否则看不出哪些已加。

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useLibrary } from '../libraryStore';
import type { Song } from '../types';

export function SongMenu({ song, anchor, onClose }: {
  song: Song;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const { favorites, playlists, toggleFav, addToPlaylist, removeFromPlaylist, newPlaylist } = useLibrary();
  const [inLists, setInLists] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [tip, setTip] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const isFav = favorites.has(song.id);

  // 打开时查一次归属，避免"看起来都能点、其实已经加过"
  useEffect(() => {
    let alive = true;
    api.songPlaylists(song.id)
      .then(r => { if (alive) setInLists(new Set(r.playlists)); })
      .catch(() => { /* 后端没起来就按空处理 */ });
    return () => { alive = false; };
  }, [song.id]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', onDown); };
  }, [onClose]);

  const flash = (msg: string) => {
    setTip(msg);
    window.setTimeout(() => setTip(t => (t === msg ? '' : t)), 1600);
  };

  const toggleInList = async (pid: string, plName: string) => {
    const has = inLists.has(pid);
    // 乐观更新勾选
    setInLists(prev => {
      const next = new Set(prev);
      if (has) next.delete(pid); else next.add(pid);
      return next;
    });
    try {
      if (has) await removeFromPlaylist(pid, song.id);
      else await addToPlaylist(pid, song.id);
      flash(has ? `已从「${plName}」移除` : `已加入「${plName}」`);
    } catch {
      // 失败回滚
      setInLists(prev => {
        const next = new Set(prev);
        if (has) next.add(pid); else next.delete(pid);
        return next;
      });
      flash('操作失败，后端没响应');
    }
  };

  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 250));
  const top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - 340));

  return createPortal(
    <div ref={boxRef} style={{ left, top }}
      className="fixed z-[9999] w-[238px] rounded-xl glass-panel p-1.5 text-white animate-[fi_0.12s]">
      <p className="px-2.5 pt-1 pb-1.5 text-[11px] text-white/30 truncate">{song.title} · {song.artist}</p>

      <button
        onClick={async () => { await toggleFav(song.id); flash(isFav ? '已取消收藏' : '已收藏到「我喜欢」'); }}
        className="w-full text-left px-2.5 py-2 rounded-lg text-[13px] hover:bg-white/8 flex items-center gap-2">
        <span className={`w-4 text-center ${isFav ? 'text-[var(--accent)]' : 'text-white/30'}`}>{isFav ? '★' : '☆'}</span>
        <span className="flex-1">{isFav ? '取消收藏' : '收藏到「我喜欢」'}</span>
        {isFav && <span className="text-[10px] text-[var(--accent)]/70">已收藏</span>}
      </button>

      <div className="my-1 border-t border-white/8" />
      <p className="px-2.5 py-1 text-[10px] text-white/25">加入歌单（可多选）</p>
      <div className="max-h-44 overflow-y-auto">
        {playlists.length === 0 && (
          <p className="px-2.5 py-2 text-[11px] text-white/25">还没有歌单，下面新建一个</p>
        )}
        {playlists.map(pl => {
          const has = inLists.has(pl.id);
          return (
            <button key={pl.id}
              onClick={() => toggleInList(pl.id, pl.name)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] flex items-center gap-2 transition-colors ${
                has ? 'text-[var(--accent)] bg-[var(--accent)]/8' : 'hover:bg-white/8'}`}>
              <span className={`w-4 text-center ${has ? 'text-[var(--accent)]' : 'text-white/15'}`}>{has ? '✓' : '+'}</span>
              <span className="truncate flex-1">{pl.name}</span>
              <span className="text-[10px] text-white/20 shrink-0">{pl.count}</span>
            </button>
          );
        })}
      </div>

      <div className="my-1 border-t border-white/8" />
      <input
        value={name} onChange={e => setName(e.target.value)}
        onKeyDown={async e => {
          if (e.key !== 'Enter' || !name.trim() || busy) return;
          setBusy(true);
          const pl = await newPlaylist(name.trim());
          if (pl) {
            await addToPlaylist(pl.id, song.id).catch(() => {});
            setInLists(prev => new Set(prev).add(pl.id));
            flash(`已新建「${pl.name}」并加入`);
            setName('');
          } else {
            flash('新建失败');
          }
          setBusy(false);
        }}
        placeholder="新建歌单，回车"
        className="mx-1 mb-1 w-[calc(100%-0.5rem)] bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)] placeholder:text-white/20"
      />
      <p className={`px-2.5 pb-1 h-4 text-[10px] transition-opacity ${tip ? 'text-[var(--accent)]/80' : 'text-transparent'}`}>
        {tip || '·'}
      </p>
    </div>,
    document.body,
  );
}
