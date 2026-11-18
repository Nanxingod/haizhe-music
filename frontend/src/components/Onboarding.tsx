// 首次启动三步引导（V15.2）
//
// 为什么需要它：全新部署时曲库默认是 ~/Music（多数人没有），打开就是一片空白，
// 用户不知道要先去设置目录。这个向导把「能听到第一首歌」的最短路径摆在面前。
//
// 触发条件：/api/status 的 songs === 0 且本地没有 haizhe-onboarded 标记。
// 每一步都能跳过——跳过之后由「全部歌曲」页的空状态按钮重新唤起。

import { useEffect, useState } from 'react';
import { api } from '../api';

const ONB_KEY = 'haizhe-onboarded';
export const OPEN_ONB_EVENT = 'haizhe-open-onboarding';
/** 曲库变化（引导里设了目录 / 重扫）后广播，列表页据此重新拉数据 */
export const LIB_EVENT = 'haizhe-library-changed';

function markDone() {
  try { localStorage.setItem(ONB_KEY, '1'); } catch { /* 隐私模式忽略 */ }
}

const STEPS = ['音乐目录', 'AI 密钥', '完成'];

export function Onboarding() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [artists, setArtists] = useState(0);
  const [ds, setDs] = useState('');
  const [tv, setTv] = useState('');

  // 首次判定：后端可能刚起，重试几次再下结论
  useEffect(() => {
    let done = false;
    try { done = localStorage.getItem(ONB_KEY) === '1'; } catch { /* ignore */ }
    if (done) return;

    let alive = true;
    (async () => {
      for (let i = 0; i < 40; i++) {   // 冷扫描 7-14s，窗口留足 28s
        try {
          const s = await api.getStatus();
          if (!alive) return;
          if (s.songs === 0) { setStep(0); setOpen(true); }
          return;
        } catch {
          await new Promise(r => setTimeout(r, 700));
        }
      }
    })();
    return () => { alive = false; };
  }, []);

  // 手动唤起（空状态按钮 / 设置页）
  useEffect(() => {
    const onOpen = () => { setStep(0); setErr(''); setOpen(true); };
    window.addEventListener(OPEN_ONB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ONB_EVENT, onOpen);
  }, []);

  // 打开时把当前目录填进去，用户能看出「现在是哪个」
  useEffect(() => {
    if (!open) return;
    api.getConfig()
      .then(c => { if (c.music_dir) setDir(d => d || c.music_dir); })
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  const ea = (window as any).electronAPI;

  const pickDir = async () => {
    if (!ea?.pickMusicDir) return;
    const d = await ea.pickMusicDir();
    if (d) { setDir(d); setErr(''); }
  };

  const saveDir = async () => {
    const d = dir.trim();
    if (!d) { setErr('请填写音乐目录'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.setMusicDir(d);
      setCount(r.songs);
      setArtists(r.artists);
      if (r.songs === 0) {
        setErr('目录已保存，但里面没有找到 mp3（会扫描子目录）。确认路径后再试，或先跳过。');
      } else {
        setStep(1);
      }
    } catch (e) {
      setErr((e as Error).message || '切换目录失败');
    } finally {
      setBusy(false);
    }
  };

  const saveKeys = async () => {
    const body: { deepseek_api_key?: string; tavily_api_key?: string } = {};
    if (ds.trim()) body.deepseek_api_key = ds.trim();
    if (tv.trim()) body.tavily_api_key = tv.trim();
    if (Object.keys(body).length === 0) { setStep(2); return; }
    setBusy(true); setErr('');
    try {
      await api.saveRelinkKeys(body);
      setStep(2);
    } catch (e) {
      setErr((e as Error).message || '保存密钥失败');
    } finally {
      setBusy(false);
    }
  };

  const skip = () => { markDone(); setOpen(false); };

  const finish = () => {
    markDone();
    setOpen(false);
    window.dispatchEvent(new Event(LIB_EVENT));
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-md px-4">
      <div className="w-full max-w-[560px] rounded-3xl bg-[var(--skin-surface,#14141f)] border border-white/10 shadow-2xl overflow-hidden">

        {/* 头部 + 步骤指示 */}
        <div className="px-7 pt-6 pb-4 border-b border-white/8">
          <p className="text-[11px] text-white/30 tracking-wide">海蜇音乐 · 首次设置</p>
          <div className="flex items-center gap-2 mt-3">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  i < step ? 'bg-[var(--accent)]/25 text-[var(--accent)]'
                  : i === step ? 'bg-[var(--accent)] text-white'
                  : 'bg-white/8 text-white/30'
                }`}>{i < step ? '✓' : i + 1}</span>
                <span className={`text-[12px] ${i === step ? 'text-white/80' : 'text-white/30'}`}>{label}</span>
                {i < STEPS.length - 1 && <span className="w-6 h-px bg-white/10" />}
              </div>
            ))}
          </div>
        </div>

        {/* 内容 */}
        <div className="px-7 py-6 min-h-[230px]">
          {step === 0 && (
            <div className="space-y-3">
              <h3 className="text-[15px] text-white/85">你的音乐放在哪个文件夹？</h3>
              <p className="text-[12px] text-white/35 leading-relaxed">
                填 mp3 所在目录（会自动扫描子目录）。填完立刻扫描，不用重启。
              </p>
              <div className="flex gap-2">
                <input
                  value={dir}
                  onChange={e => { setDir(e.target.value); setErr(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') saveDir(); }}
                  placeholder="例如 D:\Music"
                  className="flex-1 bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-[var(--accent)] transition-colors"
                />
                {ea?.pickMusicDir && (
                  <button onClick={pickDir} disabled={busy}
                    className="px-4 py-2.5 rounded-xl text-sm bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50 shrink-0">
                    浏览…
                  </button>
                )}
              </div>
              {count !== null && count > 0 && (
                <p className="text-[12px] text-[var(--accent)]/80">已扫描到 {count} 首歌 · {artists} 位歌手</p>
              )}
              {err && <p className="text-[12px] text-amber-300/75 leading-relaxed">{err}</p>}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <h3 className="text-[15px] text-white/85">要不要配置 AI 检索密钥？<span className="text-white/25 text-[12px] ml-2">可选</span></h3>
              <p className="text-[12px] text-white/35 leading-relaxed">
                不填也能正常播放。<b className="text-white/50">不填的话</b>「相关视频」只搜 B站，
                填了会额外搜抖音并用 AI 归类。
              </p>
              <div className="space-y-2">
                <input
                  type="password" value={ds} onChange={e => setDs(e.target.value)}
                  placeholder="DeepSeek API Key（sk-...）"
                  className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-[var(--accent)] transition-colors"
                />
                <input
                  type="password" value={tv} onChange={e => setTv(e.target.value)}
                  placeholder="Tavily API Key（可选，备用搜索）"
                  className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-[var(--accent)] transition-colors"
                />
              </div>
              <p className="text-[11px] text-white/25 leading-relaxed">
                只保存在本机的 backend/config.json，不会上传。之后可在设置页随时修改。
              </p>
              {err && <p className="text-[12px] text-red-300/75">{err}</p>}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h3 className="text-[15px] text-white/85">可以开始了</h3>
              <p className="text-[13px] text-white/50">
                曲库共 <b className="text-white/85">{count ?? 0}</b> 首歌。
              </p>
              <ul className="text-[12px] text-white/35 leading-relaxed space-y-1">
                <li>· 双击歌名直接播放，右键/⋯ 可收藏、加歌单</li>
                <li>· 底栏「桌词」开桌面歌词，可锁定防误触</li>
                <li>· 「效果」里有倍速/升降调；「旋律」需要先分离人声</li>
              </ul>
              <p className="text-[11px] text-white/20">
                想改目录或密钥：侧边栏「设置」。
              </p>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-7 py-4 border-t border-white/8 flex items-center gap-2">
          <button onClick={skip}
            className="px-3 py-2 rounded-lg text-[12px] text-white/30 hover:text-white/60 transition-colors">
            跳过
          </button>
          <div className="flex-1" />
          {step > 0 && (
            <button onClick={() => { setErr(''); setStep(step - 1); }} disabled={busy}
              className="px-4 py-2 rounded-lg text-[13px] bg-white/5 text-white/55 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-40">
              上一步
            </button>
          )}
          {step === 0 && (
            <button onClick={saveDir} disabled={busy}
              className="px-5 py-2 rounded-lg text-[13px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40">
              {busy ? '扫描中…' : '保存并扫描'}
            </button>
          )}
          {step === 1 && (
            <>
              <button onClick={() => setStep(2)} disabled={busy}
                className="px-4 py-2 rounded-lg text-[13px] text-white/40 hover:text-white/70 transition-colors disabled:opacity-40">
                稍后再说
              </button>
              <button onClick={saveKeys} disabled={busy}
                className="px-5 py-2 rounded-lg text-[13px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40">
                {busy ? '保存中…' : '保存并继续'}
              </button>
            </>
          )}
          {step === 2 && (
            <button onClick={finish}
              className="px-5 py-2 rounded-lg text-[13px] bg-[var(--accent)] text-white hover:brightness-110 transition-all">
              开始听歌
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
