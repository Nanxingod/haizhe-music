// 旋律面板（V14）—— 点底栏「旋律」按钮触发
//
// 展示人声轨提取出的音高曲线：横向时间、纵向音高，音块上标音名（A4 / F#4），
// 播放头固定在左侧，音符随播放向左滚动，底部跟当前歌词行。
// 数据来自 /api/melody/{song_id}，首次分析约 20 秒（CREPE/GPU），之后走缓存。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RefObject } from 'react';
import { api } from '../api';
import { usePlayer } from '../store';
import type { MelodyData } from '../types';

const W = 760;
const H = 208;
const SPAN = 6.0;        // 屏幕里显示多少秒
const LEAD = 1.5;        // 播放头左侧留多少秒
const PAD_Y = 16;
const GUTTER = 26;       // 左侧音名刻度栏宽度

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiName(m: number) {
  return `${NOTE_NAMES[Math.round(m) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
}

function findLine(data: MelodyData | null, t: number) {
  if (!data?.lines?.length) return null;
  let cur = null;
  for (const ln of data.lines) {
    if (ln.t <= t + 0.05) cur = ln;
    else break;
  }
  return cur;
}

export function MelodyPanel({ songId, songTitle, onClose, anchorRef }: {
  songId: string;
  songTitle: string;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const [data, setData] = useState<MelodyData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [lineText, setLineText] = useState('');
  const [nowNote, setNowNote] = useState('');
  const [rangeText, setRangeText] = useState('');

  // 当前显示的音域（自适应），[lo, hi]，0 表示还没算过
  const rngRef = useRef<[number, number]>([0, 0]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { state } = usePlayer();

  // 播放时间：store 的 TIME 是 500ms 节流的（timeupdate 4x/s 再降到 2Hz），
  // 直接读会一跳一跳。这里记下"上次时间 + 当时的墙钟"，rAF 里按经过时间插值。
  const clock = useRef({ t: 0, at: 0, playing: false, rate: 1 });
  if (state.currentTime !== clock.current.t) {
    clock.current = {
      t: state.currentTime, at: performance.now(),
      playing: state.isPlaying, rate: state.playbackRate || 1,
    };
  } else {
    clock.current.playing = state.isPlaying;
    clock.current.rate = state.playbackRate || 1;
  }
  const dataRef = useRef<MelodyData | null>(null);
  dataRef.current = data;
  const lineRef = useRef('');
  const noteRef = useRef('');
  const rangeRef = useRef('');

  useEffect(() => {
    let alive = true;
    setData(null); setErr(null); rngRef.current = [0, 0];
    api.getMelody(songId)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setErr(String((e as Error).message || e)); });
    return () => { alive = false; };
  }, [songId]);

  // 定位：水平居中，贴在播放栏上方
  useLayoutEffect(() => {
    const update = () => {
      const btn = anchorRef.current;
      const panel = wrapRef.current;
      const w = panel?.offsetWidth || W;
      const r = btn?.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, (window.innerWidth - w) / 2));
      const bottom = r ? Math.round(window.innerHeight - r.top + 10) : 90;
      setPos({ left: Math.round(left), bottom });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 点外部关闭
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', onDown); };
  }, [onClose]);

  // ⚠️ 依赖 data.status：canvas 是数据到了之后才渲染的，
  // 只在挂载时跑一次会拿到 null → 绘制循环永远不启动 → 一片黑。
  const ready = data?.status === 'ok' && data.notes.length > 0;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--accent').trim() || '#ff9eaf';
    // 画布底色跟着皮肤走（否则换皮肤后画布还是一块紫色）
    const surface = cs.getPropertyValue('--skin-panel-2').trim() || 'rgba(12,12,22,0.96)';

    let raf = 0;
    const draw = () => {
      const d = dataRef.current!;
      const c = clock.current;
      const cur = c.playing
        ? c.t + (performance.now() - c.at) / 1000 * c.rate
        : c.t;

      // ── 背景 ──
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = surface;
      ctx.fillRect(0, 0, W, H);
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, 'rgba(255,255,255,0.05)');
      bg.addColorStop(1, 'rgba(0,0,0,0.12)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      const t0 = cur - LEAD;
      const t1 = t0 + SPAN;

      // ⚡ 音域自适应：只按"可见窗口内的音符"撑开视野。
      // 用整首歌的固定分位会裁掉哨音/低音这类超出常规音域的段落（实测《盲选》
      // 3:20 的哨音 G5 和随后的 B5 就是这么被切掉的）。这里还做了平滑过渡，
      // 免得进出这样的段落时画面猛地拉伸。
      const vis = d.notes.filter(n => n.t < t1 + 0.8 && n.t + n.d > t0 - 0.8);
      if (vis.length) {
        let vlo = Math.min(...vis.map(n => n.midi));
        let vhi = Math.max(...vis.map(n => n.midi));
        if (vhi - vlo < 10) { const c = (vlo + vhi) / 2; vlo = c - 5; vhi = c + 5; }
        vlo -= 1.5; vhi += 1.5;
        const r = rngRef.current;
        if (r[0] === 0 && r[1] === 0) rngRef.current = [vlo, vhi];
        else { r[0] += (vlo - r[0]) * 0.07; r[1] += (vhi - r[1]) * 0.07; }
      }
      const [lo, hi] = rngRef.current;
      const span = Math.max(6, hi - lo);
      const innerH = H - PAD_Y * 2;
      const yOf = (m: number) => PAD_Y + (hi - m) / span * innerH;

      // ── 八度网格 + 左侧刻度 ──
      ctx.font = '9px system-ui';
      for (let m = Math.ceil(lo); m <= hi; m++) {
        if (m % 12 !== 0) continue;
        const y = yOf(m);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(GUTTER, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.26)';
        ctx.fillText(`C${Math.floor(m / 12) - 1}`, 6, y + 3);
      }
      // 每拍位置画一条极淡的竖线（按 0.5s 网格）
      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      for (let s = Math.ceil(t0 * 2) / 2; s < t1; s += 0.5) {
        const x = GUTTER + (s - t0) / SPAN * (W - GUTTER);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }

      // ── 音符 ──
      const bw = W - GUTTER;
      let live = '';
      for (const n of d.notes) {
        if (n.t > t1 || n.t + n.d < t0) continue;
        const x = GUTTER + (n.t - t0) / SPAN * bw;
        const w = Math.max(4, n.d / SPAN * bw - 2);
        const y = yOf(n.midi);
        const h = Math.min(20, Math.max(11, innerH / span * 0.62));
        const past = n.t + n.d <= cur;
        const sounding = n.t <= cur && cur < n.t + n.d;

        ctx.save();
        ctx.globalAlpha = past ? 0.3 : sounding ? 1 : 0.92;
        if (sounding) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = 14;
        }
        const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
        g.addColorStop(0, accent);
        g.addColorStop(1, sounding ? accent : 'rgba(255,158,175,0.55)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.roundRect(x, y - h / 2, w, h, 4);
        ctx.fill();
        ctx.restore();

        if (sounding) live = n.note;

        if (w > 30) {
          ctx.globalAlpha = past ? 0.35 : 0.95;
          ctx.fillStyle = '#141422';
          ctx.font = '600 9px system-ui';
          ctx.fillText(n.note, x + 5, y + 3.2);
          ctx.globalAlpha = 1;
        }
      }

      // ── 播放头 ──
      const px = GUTTER + LEAD / SPAN * (W - GUTTER);
      const pg = ctx.createLinearGradient(0, 0, 0, H);
      pg.addColorStop(0, 'rgba(255,255,255,0.05)');
      pg.addColorStop(0.5, 'rgba(255,255,255,0.6)');
      pg.addColorStop(1, 'rgba(255,255,255,0.05)');
      ctx.strokeStyle = pg;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.moveTo(px - 4, 0); ctx.lineTo(px + 4, 0); ctx.lineTo(px, 6);
      ctx.closePath(); ctx.fill();

      // ── React 侧文字：只在变化时 setState ──
      const rt = `${midiName(lo)}–${midiName(hi)}`;
      if (rt !== rangeRef.current) { rangeRef.current = rt; setRangeText(rt); }

      const txt = findLine(d, cur)?.text || '';
      if (txt !== lineRef.current) { lineRef.current = txt; setLineText(txt); }
      if (live !== noteRef.current) { noteRef.current = live; setNowNote(live); }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  const panel = (
    <div ref={wrapRef}
      style={pos ? { left: pos.left, bottom: pos.bottom } : { left: -9999, bottom: 90 }}
      className="fixed z-[9999] rounded-2xl glass-panel p-4 text-white animate-[fi_0.15s] w-[792px] max-w-[calc(100vw-1.5rem)]">
      <style>{'@keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>

      {/* 头部 */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] flex items-center justify-center shrink-0">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">旋律 · 音高走向</p>
            <p className="text-[11px] text-white/30 truncate">{songTitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {nowNote && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)] font-medium tabular-nums">
              ♪ {nowNote}
            </span>
          )}
          {rangeText && <span className="text-[10px] text-white/25">{rangeText}</span>}
          {data?.method && (
            <span className="text-[10px] text-white/25 tabular-nums">
              {data.method}{data.cached ? ' · 缓存' : ` · ${((data.took_ms || 0) / 1000).toFixed(0)}s`}
            </span>
          )}
          <button onClick={onClose} title="关闭"
            className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      {err && <p className="text-xs text-red-300/70 mt-3">加载失败：{err}</p>}

      {!data && !err && (
        <div className="h-[208px] flex flex-col items-center justify-center gap-2.5 text-xs text-white/30">
          <span className="w-4 h-4 border-2 border-white/15 border-t-[var(--accent)] rounded-full animate-spin" />
          正在分析人声轨…（首次约 20 秒）
        </div>
      )}

      {data?.status === 'no_vocals' && (
        <div className="h-[150px] flex flex-col items-center justify-center gap-2 text-center px-8">
          <p className="text-[13px] text-white/60">这首歌还没有分离过人声</p>
          <p className="text-[11px] text-white/30 leading-relaxed">
            旋律必须基于人声轨才能算准（混音里会被贝斯带偏）。<br />
            打开「效果 → 音轨」分离一次，再回来点这里。
          </p>
        </div>
      )}

      {data?.status === 'error' && (
        <p className="text-xs text-red-300/70 mt-3">{data.message || '分析失败'}</p>
      )}

      {ready && (
        <>
          <canvas ref={canvasRef}
            style={{
              width: W, height: H,
              WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent)',
              maskImage: 'linear-gradient(90deg, transparent, #000 3%, #000 97%, transparent)',
            }}
            className="mt-2.5 rounded-xl block max-w-full" />
          <div className="mt-2 flex items-center justify-center gap-2 h-6">
            <span className="text-[13px] text-white/60 truncate tracking-wide">{lineText || ' '}</span>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(panel, document.body);
}
