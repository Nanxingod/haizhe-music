// 缺组件时的安装引导卡片（V15）
//
// 用在：旋律面板、音效面板的音轨区、设置页。
// 只在"功能被点开、但依赖没装"时出现 —— 平时不打扰。
//
// 装完不需要重启：后端在 pip 结束后会 ensure_path() + invalidate_caches()，
// 这里 onDone() 让调用方直接重试原请求。

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

// 各功能的体积量级（别把 librosa 的 150MB 说成 torch 的 2.5GB，会把人吓退）
const SIZE_HINT: Record<string, string> = {
  stems: '约 2.5GB（含 torch）',
  melody: '约 150MB',
  pinyin: '约 1MB',
};

export function DepsMissing({ feature, missing, onDone, compact = false }: {
  feature: string;
  missing: string[];
  /** 安装完成后的回调（重新请求原接口） */
  onDone?: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  const start = async () => {
    setBusy(true); setErr(''); setLog([]); setDone(false);
    try {
      await api.installDep(feature);
      timer.current = window.setInterval(async () => {
        const j = await api.getDepJob().catch(() => null);
        if (!j) return;
        setLog((j.log || []).slice(-5));
        if (!j.running) {
          if (timer.current) window.clearInterval(timer.current);
          setBusy(false);
          if (j.ok) { setDone(true); onDone?.(); }
          else setErr(j.error || '安装失败，看日志');
        }
      }, 1200);
    } catch (e) {
      setBusy(false);
      setErr(String((e as Error).message || e));
    }
  };

  return (
    <div className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? 'py-4 px-3' : 'py-8 px-8'}`}>
      <p className="text-[13px] text-white/65">这个功能需要额外的组件</p>
      <p className="text-[11px] text-white/30 leading-relaxed">
        缺少：<span className="text-amber-300/70">{missing.join('、')}</span>
        <br />{SIZE_HINT[feature] || '体积视组件而定'}，只在第一次用时装一次。
      </p>
      {!done && (
        <button onClick={start} disabled={busy}
          className="mt-1 px-3.5 py-1.5 rounded-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-50">
          {busy ? '安装中…' : '下载并安装'}
        </button>
      )}
      {busy && log.length > 0 && (
        <div className="w-full max-w-[420px] rounded-lg bg-black/30 p-2 max-h-24 overflow-y-auto font-mono text-[10px] text-white/35 text-left space-y-0.5">
          {log.map((l, i) => <p key={i} className="truncate">{l}</p>)}
        </div>
      )}
      {done && <p className="text-[11px] text-[var(--accent)]/80">安装完成，正在重新尝试…</p>}
      {err && <p className="text-[11px] text-red-300/70">{err}</p>}
    </div>
  );
}
