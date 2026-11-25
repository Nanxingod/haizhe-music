// 缺组件时的安装引导卡片（V15 / V15.5 加 CPU·CUDA 选择）
//
// 用在：旋律面板、音效面板的音轨区。
// 只在"功能被点开、但依赖没装"时出现 —— 平时不打扰。
//
// 装完不需要重启：后端在 pip 结束后会 ensure_path() + invalidate_caches()，
// 这里 onDone() 让调用方直接重试原请求。
//
// 为什么要有变体选择：Windows 上从 PyPI/镜像拿到的 torch 一定是 CPU 版，
// CUDA 版只在 download.pytorch.org。如果不问就装，有 N 卡的用户会得到
// "装好了但 GPU 永远用不上"的结果，而界面还显示已安装。

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { DepsInfo } from '../types';

// 体积量级（别把 librosa 的 150MB 说成 torch 的 2.5GB，会把人吓退）
const SIZE_HINT: Record<string, string> = {
  stems: '约 2.5GB（含 CUDA 运行库）',
  melody: '约 150MB（不含 torch）',
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
  const [deps, setDeps] = useState<DepsInfo | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    // 只为判断"有没有 N 卡"，失败就算了（退回单一按钮）
    api.getDeps().then(setDeps).catch(() => {});
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  const gpu = !!deps?.gpu?.available;
  const torchFeature = feature === 'stems' || feature === 'melody';
  const canChoose = torchFeature && gpu && !deps?.torch?.cuda;

  const start = async (variant: 'auto' | 'cpu' | 'cuda' = 'auto') => {
    setBusy(true); setErr(''); setLog([]); setDone(false);
    try {
      await api.installDep(feature, variant);
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
        <br />{canChoose ? '选一个版本装一次即可，之后一直可用' : (SIZE_HINT[feature] || '体积视组件而定')}
      </p>

      {!done && !busy && (
        canChoose ? (
          <div className="flex flex-col items-center gap-1.5 mt-1">
            <button onClick={() => start('cuda')}
              className="px-3.5 py-1.5 rounded-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors">
              CUDA 版（约 2.5GB，推荐）
            </button>
            <button onClick={() => start('cpu')}
              className="px-3 py-1 rounded-lg text-[11px] bg-white/6 text-white/40 hover:bg-white/10 transition-colors">
              CPU 版（约 200MB，慢 10–30 倍）
            </button>
            <p className="text-[10px] text-white/20 max-w-[300px] leading-relaxed">
              已检测到 {deps?.gpu?.name || 'NVIDIA 显卡'}。CPU 版装完 GPU 加速用不上。
            </p>
          </div>
        ) : (
          <button onClick={() => start('auto')}
            className="mt-1 px-3.5 py-1.5 rounded-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors">
            下载并安装
          </button>
        )
      )}

      {busy && <p className="text-[11px] text-white/35">正在安装，可以继续听歌…</p>}
      {busy && log.length > 0 && (
        <div className="w-full max-w-[420px] rounded-lg bg-black/30 p-2 max-h-24 overflow-y-auto font-mono text-[10px] text-white/35 text-left space-y-0.5">
          {log.map((l, i) => <p key={i} className="truncate">{l}</p>)}
        </div>
      )}
      {done && <p className="text-[11px] text-[var(--accent)]/80">安装完成，正在重新尝试…</p>}
      {err && <p className="text-[11px] text-red-300/70 max-w-[360px]">{err}</p>}
    </div>
  );
}
