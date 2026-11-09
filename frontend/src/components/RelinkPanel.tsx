// 相关视频面板（V13）—— 双击底栏歌名触发
//
// 展示后端 /api/relinks/{id} 的结果：
//   现场版 → 优秀翻唱 → MV → 其他相关（组内 B站 优先于 抖音）
// 两段式：首屏先出 B站（约 1 秒），抖音 + AI 排序后台补齐，面板自己轮询合并。
// 结果会持久化到 <音乐目录>/相关视频/，所以标题栏会显示「搜索于 xx」，避免重复花钱。

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api, API_BASE } from '../api';
import type { RelinkResult, RelinkConfig, RelinkOrigin, ArtistInfo } from '../types';

/** 播放量：12345 → 1.2万 */
function fmtPlay(n: number): string {
  if (!n) return '';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/** 时间戳 → 「今天 14:05」/「10-28 14:05」 */
function fmtWhen(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = (x: number) => String(x).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`;
}

const ORIGIN_LABEL: Record<RelinkOrigin, string> = {
  network: '刚搜的',
  memory: '内存缓存',
  disk: '本地缓存',
};

/** 用系统默认浏览器打开；网页版退回新标签页 */
async function openLink(url: string) {
  const ea = (window as any).electronAPI;
  if (ea?.openExternal) {
    const ok = await ea.openExternal(url);
    if (ok) return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

const SOURCE_STYLE: Record<string, string> = {
  bilibili: 'bg-[#fb7299]/15 text-[#ff9db8]',
  douyin: 'bg-white/10 text-white/60',
};

export function RelinkPanel({ scope = 'song', ident, title, artistName, onClose, anchorRef }: {
  /** song=歌曲维度（ident 是 song_id）；artist=歌手维度（ident 是歌手名） */
  scope?: 'song' | 'artist';
  ident: string;
  /** 面板副标题 */
  title: string;
  /** 这首歌的歌手名（歌曲维度也要显示歌手简介，由调用方传入） */
  artistName?: string;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [data, setData] = useState<RelinkResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);   // 网络抖动自动重试中
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<RelinkConfig | null>(null);
  const [nonce, setNonce] = useState(0);             // 手动重试用
  /** 歌手维度：面板顶部额外展示歌手名片，让「搜歌手」和「搜歌曲」一眼能区分 */
  const [artist, setArtist] = useState<ArtistInfo | null>(null);
  const [bioOpen, setBioOpen] = useState(false);   // 简介是否展开

  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const aliveRef = useRef(true);
  const navigate = useNavigate();

  // 面板挂在 document.body 上（portal），用 fixed 定位：
  // 左边缘对齐锚点，底边贴在锚点上方 10px。这样不会被侧边栏/播放栏的
  // stacking context 压住（之前 absolute + z-50 仍会被侧边栏盖住）。
  useLayoutEffect(() => {
    const update = () => {
      const btn = anchorRef.current;
      const panel = panelRef.current;
      if (!btn || !panel) return;
      const r = btn.getBoundingClientRect();
      const w = panel.offsetWidth || 460;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      // 面板向上生长，可用高度 = 锚点顶部到窗口顶部的距离 - 留白。
      // 不限高的话简介一展开就顶出屏幕外面（截图现场）。
      const maxHeight = Math.max(220, Math.round(r.top - 16));
      setPos({ left: Math.round(left), bottom: Math.round(window.innerHeight - r.top + 10), maxHeight });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点击面板外关闭
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', onDown); };
  }, [onClose]);

  // 拉取（首次 + 轮询 pending）
  // 关键：网络抖动/后端重启导致的 fetch 失败不能直接放弃 —— 之前一次失败就报
  // 「搜索失败：Failed to fetch」并停掉轮询，而其实那只是 Vite 代理短暂中断。
  // 现在连续失败会退避重试 4 次，每次请求还有 25s 超时，避免永远挂着。
  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;        // 成功轮次，用于限制 pending 轮询次数
    let fails = 0;        // 连续失败次数

    const schedule = (ms: number) => {
      if (!aliveRef.current) return;
      timer = setTimeout(tick, ms);
    };

    const tick = async () => {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 25000);
      try {
        const r = scope === 'artist'
          ? await api.getArtistRelinks(ident, false, ac.signal)
          : await api.getRelinks(ident, false, ac.signal);
        if (!aliveRef.current) return;
        fails = 0;
        setData(r);
        setErr(null);
        setRetrying(false);
        setLoading(false);
        if (r.pending && polls < 12) {          // 最多补 12 轮 ≈ 24s
          polls += 1;
          schedule(2000);
        }
      } catch (e) {
        if (!aliveRef.current) return;
        fails += 1;
        const isAbort = e instanceof DOMException && e.name === 'AbortError';
        const msg = isAbort ? '请求超时' : String((e as Error).message || e);
        setLoading(false);
        if (fails <= 4) {
          setRetrying(true);
          setErr(`连接中断（${msg}），正在自动重试 ${fails}/4`);
          schedule(1200 * fails);              // 1.2s / 2.4s / 3.6s / 4.8s
        } else {
          setRetrying(false);
          setErr(`搜索失败：${msg}`);
        }
      } finally {
        clearTimeout(to);
      }
    };

    setLoading(true);
    setData(null);
    setErr(null);
    setRetrying(false);
    tick();
    return () => { aliveRef.current = false; if (timer) clearTimeout(timer); };
  }, [ident, scope, nonce]);

  // 顶部歌手名片：两个维度都显示（歌曲维度用这首歌的歌手），
  // 既让两个面板一眼可分，也顺带把歌手简介露出来
  const who = (artistName || (scope === 'artist' ? ident : '')).trim();
  useEffect(() => {
    if (!who) { setArtist(null); return; }
    let alive = true;
    api.getArtistInfo(who)
      .then(d => { if (alive) setArtist(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [who]);

  // 读 key 配置状态（只用于提示，缺 key 时引导去设置页）
  useEffect(() => {
    fetch(`${API_BASE}/api/config`).then(r => r.json())
      .then((c: { relink?: RelinkConfig }) => setCfg(c.relink ?? null))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setRetrying(false);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 40000);   // 重搜要跑全链路，给宽一点
    try {
      const r = scope === 'artist'
        ? await api.getArtistRelinks(ident, true, ac.signal)
        : await api.getRelinks(ident, true, ac.signal);
      setData(r);
    } catch (e) {
      const isAbort = e instanceof DOMException && e.name === 'AbortError';
      setErr(`搜索失败：${isAbort ? '请求超时' : String((e as Error).message || e)}`);
    } finally {
      clearTimeout(to);
      setLoading(false);
    }
  }, [ident, scope]);

  const goSettings = () => { onClose(); navigate('/settings'); };

  const missingKey = cfg && !cfg.deepseek;   // Tavily 只是抖音备用通道，缺了不算问题
  const total = data?.total ?? 0;
  const douyinCount = data
    ? data.groups.reduce((n, g) => n + g.items.filter(i => i.source === 'douyin').length, 0)
    : 0;

  const panel = (
    <div ref={panelRef}
      style={pos
        ? { left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight }
        : { left: -9999, bottom: 90 }}
      className="fixed z-[9999] w-[460px] max-md:w-[calc(100vw-1rem)] rounded-2xl glass-panel p-4 text-white animate-[fi_0.15s] flex flex-col overflow-hidden">
      <style>{'@keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>

      {/* 标题栏 */}
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {scope === 'artist' ? `${title} · 相关视频` : '现场版 · 翻唱 · MV'}
          </p>
          <p className="text-[11px] text-white/30 truncate">
            {scope === 'artist' ? '这位歌手的现场 / 翻唱 / MV' : title}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {data?.ai && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]/80"
              title="由 DeepSeek 归类并写短评">AI</span>
          )}
          <button onClick={refresh} disabled={loading} title="重新搜索（会重新消耗 API 额度）"
            className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
            </svg>
          </button>
          <button onClick={onClose} title="关闭"
            className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {/* 搜索时间 / 来源 */}
      {data && (
        <div className="flex items-center gap-1.5 text-[10px] text-white/25 mt-1 shrink-0">
          <span>{data.pending ? '搜索中…' : `搜索于 ${fmtWhen(data.fetched_at)}`}</span>
          {!data.pending && data.source !== 'network' && (
            <>
              <span className="text-white/15">·</span>
              <span>{ORIGIN_LABEL[data.source]}</span>
            </>
          )}
          {!data.pending && data.source === 'network' && data.took_ms > 0 && (
            <>
              <span className="text-white/15">·</span>
              <span>{(data.took_ms / 1000).toFixed(1)}s</span>
            </>
          )}
        </div>
      )}

      {/* 歌手名片 + 简介：两个维度都显示（歌曲维度用这首歌的歌手） */}
      {artist?.found && (
        <div className="mt-2 px-2.5 py-2 rounded-xl bg-white/6 shrink-0">
          <div className="flex items-center gap-2.5">
            {artist.avatar && (
              <img src={artist.avatar} alt="" loading="lazy"
                className="w-9 h-9 rounded-full object-cover shrink-0 bg-white/5"
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-white/80 truncate">
                {artist.name}
                {artist.alias.length > 0 && (
                  <span className="text-white/30"> · {artist.alias.slice(0, 2).join(' / ')}</span>
                )}
                {artist.brief_source === 'ai' && (
                  <span title="接口没有有效简介，这段由 DeepSeek 生成"
                    className="ml-1 text-[9px] px-1 py-px rounded bg-white/10 text-white/35 align-middle">AI</span>
                )}
              </p>
              <p className="text-[10px] text-white/25 truncate">
                {[
                  artist.fans > 0 ? `${fmtPlay(artist.fans)} 粉丝` : '',
                  artist.music_count > 0 ? `${artist.music_count} 首作品` : '',
                ].filter(Boolean).join(' · ') || '网易云音乐'}
              </p>
            </div>
            {artist.brief && (
              <button onClick={() => setBioOpen(v => !v)}
                className="text-[10px] shrink-0 px-1.5 py-0.5 rounded text-white/35 hover:text-white/70 hover:bg-white/10 transition-colors">
                {bioOpen ? '收起' : '展开'}
              </button>
            )}
          </div>
          {artist.brief && (
            <p className={`text-[11px] text-white/40 leading-relaxed mt-1.5 ${bioOpen ? 'max-h-32 overflow-y-auto pr-1' : 'line-clamp-2'}`}>
              {artist.brief}
            </p>
          )}
        </div>
      )}

      {/* 后台补齐提示 */}
      {data?.pending && (
        <div className="flex items-center gap-2 text-[11px] text-white/35 mt-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
          正在补充抖音结果与 AI 排序…
        </div>
      )}

      {/* 内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto -mr-1 pr-1 mt-2 space-y-3">
        {loading && !data && (
          <div className="py-8 text-center text-xs text-white/25">搜索中…</div>
        )}

        {err && (
          retrying ? (
            <div className="flex items-center gap-2 text-[11px] text-amber-300/75 py-2">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-300/80 animate-pulse shrink-0" />
              <span className="break-all">{err}</span>
            </div>
          ) : (
            <div className="py-3 text-center space-y-2">
              <p className="text-xs text-red-300/70 break-all">{err}</p>
              <button onClick={() => setNonce(n => n + 1)}
                className="text-[11px] px-2.5 py-1 rounded-lg text-white/55 hover:bg-white/10 hover:text-white transition-colors">
                重试
              </button>
            </div>
          )
        )}

        {!loading && !err && data && total === 0 && (
          <p className="py-6 text-center text-xs text-white/30">
            没搜到相关视频，换个歌试试
          </p>
        )}

        {data?.groups.map(g => (
          <section key={g.key}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[11px] font-medium text-white/45">{g.label}</span>
              <span className="text-[10px] text-white/20">{g.items.length}</span>
              <span className="flex-1 h-px bg-white/8" />
            </div>
            <div className="space-y-1">
              {g.items.map(it => (
                <button key={it.url} onClick={() => openLink(it.url)}
                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/8 transition-colors group">
                  <div className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 text-[10px] px-1.5 py-0.5 rounded ${SOURCE_STYLE[it.source] || 'bg-white/10 text-white/60'}`}>
                      {it.source_label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-snug text-white/85 line-clamp-2 group-hover:text-white">
                        {it.title}
                      </p>
                      {it.blurb && (
                        <p className="text-[11px] text-[var(--accent)]/70 mt-0.5">{it.blurb}</p>
                      )}
                      <p className="text-[10px] text-white/25 mt-0.5 truncate">
                        {[it.author, fmtPlay(it.play) && `${fmtPlay(it.play)}播放`, it.duration]
                          .filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <svg className="shrink-0 mt-1 text-white/15 group-hover:text-white/50 transition-colors"
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <path d="M15 3h6v6M10 14 21 3" />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}

        {data?.notes.map(n => (
          <p key={n} className="text-[10px] text-white/25 leading-relaxed">· {n}</p>
        ))}

        {/* 抖音没搜到就中性说明一句，不要报「失败」——它本来就是个点缀来源 */}
        {data && !data.pending && total > 0 && douyinCount === 0 && (
          <p className="text-[10px] text-white/25 pt-0.5">暂无抖音内容</p>
        )}
      </div>

      {/* 缺 key 时引导去设置页（key 统一在「设置 → AI 接口密钥」里配） */}
      {missingKey && (
        <div className="mt-2 pt-2 border-t border-white/10 flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-white/30">未配置 DeepSeek key（只能搜 B站、无 AI 短评）</span>
          <button onClick={goSettings}
            className="text-[10px] px-1.5 py-0.5 rounded text-[var(--accent)]/80 hover:bg-white/10 transition-colors">
            去设置里填写 ›
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
