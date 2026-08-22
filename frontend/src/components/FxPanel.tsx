// 音效面板 - 倍速 / 移调(升降KEY) / 小黄人 / 人声分离音轨
// V12.1：面板宽度加大至 400px，水平中心与"效果"按钮对齐（而非右下角展开）

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { usePlayer } from '../store';
import { api } from '../api';
import type { Stem, StemStatus, StemQuality } from '../types';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function FxPanel({ onClose, anchorRef }: {
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement | null>;
}) {
  const { state, dispatch } = usePlayer();
  const { playbackRate, pitchSemitones, chipmunk, stem, currentSong } = state;
  const [stemStatus, setStemStatus] = useState<StemStatus | null>(null);
  const [busy, setBusy] = useState(false); // 分离请求进行中
  const [quality, setQuality] = useState<StemQuality>('standard');
  const qualityTouchedRef = useRef(false); // 用户手动选过质量后不再自动切换
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);

  const semis = pitchSemitones;
  const semisLabel = semis === 0 ? '原调' : `${semis > 0 ? '+' : ''}${semis} 半音`;

  // 面板水平中心对齐锚点按钮中心（clamp 在视口内）
  useLayoutEffect(() => {
    const update = () => {
      const btn = anchorRef.current;
      const panel = panelRef.current;
      if (!btn || !panel) return;
      const w = panel.offsetWidth;
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const left = Math.max(8, Math.min(cx - w / 2, window.innerWidth - w - 8));
      setPos({ left: Math.round(left), right: 'auto' });
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
    // 延迟绑定，避免打开面板的那次点击立即把它关掉
    const t = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', onDown); };
  }, [onClose]);

  // 轮询当前歌的分离状态（面板打开期间，2s 一次）
  useEffect(() => {
    if (!currentSong) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.getStems(currentSong.id);
        if (cancelled) return;
        setStemStatus(s);
        // 首次拿到 GPU 状态时设定默认质量：有 GPU 直接选高质量（效果好且快）
        if (!qualityTouchedRef.current) {
          setQuality(prev => (prev === 'standard' && s.gpu && s.status === 'none') ? 'hq' : prev);
        }
      } catch {}
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [currentSong?.id]);

  // 用户手动选择质量
  const chooseQuality = (q: StemQuality) => {
    qualityTouchedRef.current = true;
    setQuality(q);
  };

  const setRate = useCallback((rate: number) => dispatch({ type: 'SET_RATE', rate }), [dispatch]);
  const setPitch = useCallback((n: number) => dispatch({ type: 'SET_PITCH', semitones: n }), [dispatch]);

  const startSeparation = async (q: StemQuality = quality) => {
    if (!currentSong || busy) return;
    setBusy(true);
    try {
      await api.separateStems(currentSong.id, q);
      setStemStatus(prev => prev ? { ...prev, status: 'processing', progress: prev.progress || 2, quality: q } : prev);
    } catch (e) {
      setStemStatus(prev => prev ? { ...prev, status: 'error', error: String((e as Error).message || e) } : prev);
    } finally {
      setBusy(false);
    }
  };

  const chooseStem = (s: Stem) => {
    if (s !== 'original' && stemStatus?.status !== 'ready') return;
    dispatch({ type: 'SET_STEM', stem: s });
  };

  const stemBtn = (s: Stem, label: string) => {
    const active = stem === s;
    const disabled = s !== 'original' && stemStatus?.status !== 'ready';
    return (
      <button
        disabled={disabled}
        onClick={() => chooseStem(s)}
        className={`flex-1 py-2.5 rounded-lg text-sm transition-colors ${
          active ? 'bg-[var(--accent)] text-white font-medium'
                 : disabled ? 'text-white/15 cursor-not-allowed'
                 : 'text-white/60 hover:text-white hover:bg-white/10'}`}>
        {label}
      </button>
    );
  };

  return (
    <div ref={panelRef} style={pos ?? undefined}
      className="absolute bottom-16 right-4 z-50 w-[440px] max-md:w-[calc(100vw-1rem)] max-md:right-2 rounded-2xl glass p-6 text-white shadow-2xl border border-white/10 animate-[fi_0.15s]">
      <style>{'@keyframes fi{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>

      {/* 标题 */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium">音效</span>
        <span className="text-xs text-white/25">{currentSong?.title || ''}</span>
      </div>

      {/* 倍速 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/40">倍速</span>
        <span className="text-xs text-white/30">{playbackRate === 1 ? '正常' : `${playbackRate}x`}</span>
      </div>
      <div className="flex gap-2 mb-5">
        {RATES.map(r => (
          <button key={r} onClick={() => setRate(r)}
            className={`flex-1 py-2.5 rounded-lg text-sm transition-colors ${
              playbackRate === r ? 'bg-[var(--accent)] text-white font-medium' : 'text-white/55 hover:text-white hover:bg-white/10'}`}>
            {r === 1 ? '1x' : `${r}x`}
          </button>
        ))}
      </div>

      {/* 移调 */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/40">升降 KEY</span>
        <span className="text-xs text-white/30">{semisLabel}</span>
      </div>
      <div className="flex items-center gap-3 mb-5">
        <button onClick={() => setPitch(semis - 1)} disabled={semis <= -12} title="降半音"
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-25 text-lg leading-none shrink-0 transition-colors">−</button>
        <input type="range" min={-12} max={12} step={1} value={semis}
          onChange={e => setPitch(Number(e.target.value))}
          className="progress-bar flex-1"
          style={{ backgroundImage: `linear-gradient(to right, var(--accent) ${((semis + 12) / 24) * 100}%, rgba(255,255,255,0.06) ${((semis + 12) / 24) * 100}%)` }} />
        <button onClick={() => setPitch(semis + 1)} disabled={semis >= 12} title="升半音"
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-25 text-lg leading-none shrink-0 transition-colors">＋</button>
        {semis !== 0 && (
          <button onClick={() => setPitch(0)}
            className="text-xs px-2.5 py-2 rounded-lg text-white/35 hover:text-white hover:bg-white/10 shrink-0 transition-colors">复位</button>
        )}
      </div>

      {/* 小黄人 */}
      <label className="flex items-center justify-between mb-5 py-1 cursor-pointer select-none"
        onClick={() => dispatch({ type: 'TOGGLE_CHIPMUNK' })}>
        <div>
          <span className="text-sm text-white/60">小黄人变声</span>
          <p className="text-[11px] text-white/25 mt-0.5">加速时音调同步升高（花栗鼠音效）</p>
        </div>
        <span className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${chipmunk ? 'bg-[var(--accent)]' : 'bg-white/15'}`}>
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${chipmunk ? 'left-[18px]' : 'left-0.5'}`} />
        </span>
      </label>

      <div className="border-t border-white/10 my-3" />

      {/* 音轨（人声分离） */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/40">音轨</span>
        {stemStatus?.status === 'processing' && (
          <span className="text-xs text-[var(--accent)]">{stemStatus.progress ?? 0}%</span>
        )}
      </div>
      <div className="flex gap-1.5 mb-3">
        {stemBtn('original', '原唱')}
        {stemBtn('vocals', '人声')}
        {stemBtn('instrumental', '伴奏')}
      </div>

      {/* 分离状态区 */}
      {!stemStatus && <p className="text-xs text-white/25">查询分离状态中…</p>}
      {stemStatus && stemStatus.status === 'none' && (
        <div>
          {/* 质量选择 */}
          <div className="flex gap-2 mb-2">
            {([['standard', '标准'], ['hq', '高质量']] as const).map(([q, label]) => (
              <button key={q} onClick={() => chooseQuality(q)}
                className={`flex-1 py-2 rounded-lg text-[13px] transition-colors ${
                  quality === q ? 'bg-white/15 text-white font-medium' : 'text-white/45 hover:text-white hover:bg-white/10'}`}>
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-white/25 mb-2.5 leading-relaxed">
            {quality === 'hq'
              ? (stemStatus.gpu ? 'BS-Roformer 顶级模型 · GPU 约 30 秒' : 'BS-Roformer 顶级模型（首次需下载约 640MB）· 无 GPU 时 CPU 约 20-40 分钟')
              : 'MDX 模型，CPU 约 1-3 分钟，质量良好'}
          </p>
          <button onClick={() => startSeparation()} disabled={busy}
            className="w-full py-3 rounded-lg text-sm bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-50">
            {busy ? '启动中…' : '人声 / 伴奏分离'}
          </button>
          {!stemStatus.available && (
            <p className="text-[11px] text-white/25 mt-2 leading-relaxed">
              需要后端安装 audio-separator：pip install audio-separator
            </p>
          )}
        </div>
      )}
      {stemStatus && stemStatus.status === 'processing' && (
        <div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full bg-[var(--accent)] transition-all duration-500"
              style={{ width: `${stemStatus.progress ?? 0}%` }} />
          </div>
          <p className="text-[11px] text-white/25 mt-2">
            正在分离{stemStatus.quality === 'hq' ? '（高质量模型，耗时较长）' : ''}，可在后台等待，完成后自动可切换音轨
          </p>
        </div>
      )}
      {stemStatus && stemStatus.status === 'error' && (
        <p className="text-xs text-red-300/70 break-all">分离失败：{stemStatus.error}</p>
      )}
      {stemStatus && stemStatus.status === 'ready' && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-white/25">
            已缓存{stemStatus.quality === 'hq' ? '高质量' : '标准'}分离结果，切音轨保留进度
          </p>
          {stemStatus.quality !== 'hq' && (
            <button onClick={() => startSeparation('hq')} disabled={busy}
              className="text-xs px-2.5 py-1.5 rounded-lg text-[var(--accent)]/70 hover:text-[var(--accent)] hover:bg-white/10 shrink-0 disabled:opacity-50 transition-colors">
              升级高质量
            </button>
          )}
        </div>
      )}
    </div>
  );
}
