// 音乐画像（彩蛋）—— 曲库统计 + AI 风格归类 + 可能想听
//
// 数据来自 /api/insights（后端分批打标，增量缓存）。页面只做展示与轮询，
// 不参与分析逻辑；分析可以离开本页继续跑（后端线程）。

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { InsightGenre, InsightsState, InsightPick } from '../types';

const PALETTE = [
  '#7C9CF5', '#5BC8AF', '#E8B36A', '#DE7F9C', '#9B8CF0',
  '#63B7E8', '#C9BE6C', '#86BE7C', '#C98F6B', '#7FA6A0',
];

const KIND_LABEL: Record<string, { text: string; cls: string }> = {
  safe: { text: '同风格', cls: 'bg-[var(--accent)]/15 text-[var(--accent)]' },
  adjacent: { text: '相邻风格', cls: 'bg-white/8 text-white/45' },
  explore: { text: '探索', cls: 'bg-amber-300/12 text-amber-200/70' },
};

const fmtTime = (ts: number) => new Date(ts * 1000).toLocaleString();

function openUrl(url: string) {
  const ea = (window as any).electronAPI;
  if (ea?.openExternal) ea.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** 环形饼图：用 stroke-dasharray 画扇区，不引入图表库 */
function Donut({ genres, total }: { genres: InsightGenre[]; total: number }) {
  const R = 60;
  const C = 2 * Math.PI * R;
  // 先算出每段的起始百分比，避免在 map 里累加（render 期改外部变量会被 lint 拦）
  const segs = genres.map((g, i) => ({
    ...g,
    color: PALETTE[i % PALETTE.length],
    start: genres.slice(0, i).reduce((sum, x) => sum + x.pct, 0),
  }));
  return (
    <div className="relative shrink-0" style={{ width: 176, height: 176 }}>
      <svg viewBox="0 0 160 160" width={176} height={176}>
        <circle cx="80" cy="80" r={R} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="22" />
        {segs.map(g => {
          const len = C * (g.pct / 100);
          return (
            <circle key={g.name} cx="80" cy="80" r={R} fill="none"
              stroke={g.color} strokeWidth="22"
              strokeDasharray={`${Math.max(0, len - 1)} ${C - Math.max(0, len - 1)}`}
              strokeDashoffset={-(C * g.start / 100)}
              transform="rotate(-90 80 80)" />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-2xl font-semibold">{total}</span>
        <span className="text-[11px] text-white/30">首</span>
      </div>
    </div>
  );
}

function StatTile({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="rounded-2xl glass-light px-4 py-3">
      <p className="text-[11px] text-white/30">{label}</p>
      <p className="text-xl font-semibold mt-1">
        {value}<span className="text-[12px] font-normal text-white/30 ml-1">{unit}</span>
      </p>
    </div>
  );
}

function PickCard({ pick }: { pick: InsightPick }) {
  const [imgOk, setImgOk] = useState(true);
  const kind = KIND_LABEL[pick.kind] || KIND_LABEL.adjacent;
  return (
    <div className="rounded-2xl glass-light p-3.5 flex gap-3">
      <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 bg-white/6 flex items-center justify-center text-white/20">
        {pick.cover && imgOk
          ? <img src={pick.cover} alt="" referrerPolicy="no-referrer" loading="lazy"
            className="w-full h-full object-cover" onError={() => setImgOk(false)} />
          : <span className="text-lg">♪</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium truncate">{pick.title}</p>
          <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${kind.cls}`}>{kind.text}</span>
          {!pick.verified && <span className="shrink-0 text-[10px] text-white/20" title="网易云未搜到，链接是搜索页">未校验</span>}
        </div>
        <p className="text-[11px] text-white/45 truncate">{pick.artist}{pick.genre ? ` · ${pick.genre}` : ''}</p>
        {pick.reason && <p className="text-[11px] text-white/35 mt-1 line-clamp-2 leading-relaxed">{pick.reason}</p>}
        <div className="flex items-center gap-3 mt-1.5">
          <button onClick={() => openUrl(pick.url)}
            className="text-[11px] text-[var(--accent)]/70 hover:text-[var(--accent)] transition-colors">
            网易云
          </button>
          <button onClick={() => openUrl(pick.bili)}
            className="text-[11px] text-white/30 hover:text-white/60 transition-colors">
            B站找现场
          </button>
        </div>
      </div>
    </div>
  );
}

export function InsightsPage() {
  const [data, setData] = useState<InsightsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [recBusy, setRecBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.getInsights());
      setErr('');
    } catch (e) {
      setErr((e as Error).message || '加载失败');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 分析中每 3 秒刷新进度（离开页面就停，后端照跑）
  useEffect(() => {
    if (!data?.job.running) return;
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [data?.job.running, load]);

  const startAnalyze = async () => {
    setBusy(true); setErr('');
    try { await api.analyzeInsights(); await load(); }
    catch (e) { setErr((e as Error).message || '启动失败'); }
    finally { setBusy(false); }
  };

  const regenerate = async () => {
    setRecBusy(true); setErr('');
    try {
      const r = await api.recommendInsights();
      setData(d => (d && d.profile)
        ? { ...d, profile: { ...d.profile, recommendations: r } }
        : d);
    } catch (e) {
      setErr((e as Error).message || '生成推荐失败');
    } finally { setRecBusy(false); }
  };

  const profile = data?.profile;
  const job = data?.job;
  const recs = profile?.recommendations;
  const batches = data ? Math.max(1, Math.ceil(data.songs / 45)) : 0;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* 头部 */}
      <div className="sticky top-0 z-10 glass border-b border-white/5 px-8 py-5 max-md:px-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold max-md:text-xl">
              音乐画像
              <span className="ml-2 align-middle text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]">彩蛋</span>
            </h1>
            <p className="text-white/30 text-sm mt-0.5">
              本地统计 + AI 风格归类 · 只发送歌名与歌手，不上传音频
            </p>
          </div>
          <div className="flex items-center gap-2">
            {profile && !data?.has_key && (
              <span className="text-[11px] text-white/25">未配置 Key，当前只能查看</span>
            )}
            {profile && data?.has_key && (
              <button onClick={startAnalyze} disabled={busy || job?.running}
                className="px-3 py-1.5 rounded-lg text-xs bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors disabled:opacity-40">
                {job?.running ? '分析中…' : '重新分析'}
              </button>
            )}
            {profile && data?.has_key && (
              <button onClick={regenerate} disabled={recBusy}
                className="px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40">
                {recBusy ? '生成中…' : '换一批'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="px-8 py-6 space-y-6 max-w-5xl max-md:px-4">

        {err && <p className="text-[12px] text-red-300/80">{err}</p>}

        {/* ① 没有 Key 且还没有画像（有画像时照常展示，只是不能再换一批） */}
        {data && !data.has_key && !profile && (
          <section className="glass-light rounded-2xl p-7 text-center space-y-3">
            <div className="text-2xl">✦</div>
            <h2 className="text-[15px] text-white/85">需要先配置 DeepSeek API Key</h2>
            <p className="text-[12px] text-white/35 leading-relaxed max-w-[460px] mx-auto">
              分析会把「歌名 + 歌手」发给模型打风格标签（不含音频、不含文件路径），
              汇总成风格占比与常听歌手。不配 Key 也不影响播放。
            </p>
            <Link to="/settings"
              className="inline-block mt-1 px-4 py-2 rounded-xl text-[13px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors">
              去设置里填写 Key
            </Link>
          </section>
        )}

        {/* ② 已经在跑 */}
        {job?.running && (
          <section className="glass-light rounded-2xl p-6 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-white/70">
                {job.stage === '汇总' ? '正在汇总结果…' : `正在给歌曲打风格标签… ${job.done}/${job.total}`}
              </p>
              <span className="text-[12px] text-[var(--accent)]">{job.progress}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-[var(--accent)] transition-all duration-500"
                style={{ width: `${job.progress}%` }} />
            </div>
            <p className="text-[11px] text-white/25">
              每批 45 首依次分析，中途可以离开本页，后台会继续跑；已完成的批次会立即写入缓存。
            </p>
          </section>
        )}

        {job?.error && <p className="text-[12px] text-amber-300/80">分析中断：{job.error}</p>}

        {/* ③ 还没分析过 */}
        {data && data.has_key && !profile && !job?.running && (
          <section className="glass-light rounded-2xl p-8 text-center space-y-4">
            <div className="text-2xl">🎼</div>
            <h2 className="text-[16px] text-white/85">看看你的曲库是什么口味</h2>
            <p className="text-[12px] text-white/35 leading-relaxed max-w-[480px] mx-auto">
              曲库共 <b className="text-white/60">{data.songs}</b> 首，会分成 <b className="text-white/60">{batches}</b> 批依次分析，
              预计 <b className="text-white/60">{Math.max(1, Math.round(batches * 0.2))}</b> 分钟左右。
              之后新增歌曲只分析增量部分。
            </p>
            <div className="text-[11px] text-white/25 leading-relaxed">
              产出：风格占比饼图 · 偏好标签 · 常听歌手 · 「可能想听」推荐
            </div>
            <button onClick={startAnalyze} disabled={busy}
              className="mt-1 px-5 py-2.5 rounded-xl text-[13px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40">
              {busy ? '启动中…' : `开始分析（${data.songs} 首）`}
            </button>
          </section>
        )}

        {/* ④ 有画像 */}
        {profile && (
          <>
            {data?.stale && (
              <div className="rounded-xl bg-amber-300/8 border border-amber-300/15 px-4 py-2.5 text-[11px] text-amber-200/70">
                曲库有变化（新增或删除了歌曲），这份画像生成于 {fmtTime(profile.generated_at)}。
                点右上「重新分析」只会补跑新增的歌曲。
              </div>
            )}

            {(profile.stats.unlabeled ?? 0) > 0 && (
              <div className="rounded-xl bg-amber-300/8 border border-amber-300/15 px-4 py-2.5 text-[11px] text-amber-200/70">
                还有 {profile.stats.unlabeled} 首没分类（上次请求失败或中途中断），点「重新分析」只会补跑这些。
              </div>
            )}

            {/* 统计卡片 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile label="曲库歌曲" value={profile.stats.songs} unit="首" />
              <StatTile label="歌手" value={profile.stats.artists} unit="位" />
              <StatTile label="总时长" value={profile.stats.hours} unit="小时" />
              <StatTile label="歌词覆盖" value={profile.stats.lyrics_pct} unit="%" />
            </div>

            <div className="grid lg:grid-cols-2 gap-5">
              {/* 风格饼图 */}
              <section className="glass-light rounded-2xl p-5">
                <h2 className="text-[13px] text-white/60 mb-3">风格构成</h2>
                <div className="flex items-center gap-5 flex-wrap">
                  <Donut genres={profile.genres.slice(0, 9)} total={profile.stats.songs} />
                  <div className="flex-1 min-w-[150px] space-y-1.5">
                    {profile.genres.slice(0, 8).map((g, i) => (
                      <div key={g.name} className="flex items-center gap-2 text-[12px]">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PALETTE[i % PALETTE.length] }} />
                        <span className="text-white/55 truncate">{g.name}</span>
                        <span className="ml-auto text-white/30 tabular-nums">{g.pct}%</span>
                        <span className="text-white/15 text-[11px] tabular-nums w-8 text-right">{g.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-[10px] text-white/15 mt-3">
                  按标签出现次数统计（一首歌可能有 1-3 个标签）
                </p>
              </section>

              {/* 标签 + 歌手 */}
              <section className="glass-light rounded-2xl p-5">
                <h2 className="text-[13px] text-white/60 mb-3">偏好标签</h2>
                <div className="space-y-1.5">
                  {profile.tags.slice(0, 9).map((t, i) => {
                    const max = profile.tags[0]?.count || 1;
                    return (
                      <div key={t.name} className="flex items-center gap-2">
                        <span className="text-[11px] text-white/45 w-14 shrink-0 truncate">{t.name}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-white/6 overflow-hidden">
                          <div className="h-full rounded-full"
                            style={{ width: `${Math.max(4, (t.count / max) * 100)}%`, background: PALETTE[i % PALETTE.length] }} />
                        </div>
                        <span className="text-[10px] text-white/25 tabular-nums w-7 text-right">{t.count}</span>
                      </div>
                    );
                  })}
                </div>

                <h3 className="text-[13px] text-white/60 mt-5 mb-2">常听歌手</h3>
                <div className="flex flex-wrap gap-1.5">
                  {profile.artists.slice(0, 10).map(a => (
                    <span key={a.name} className="text-[11px] px-2 py-1 rounded-lg bg-white/5 text-white/45">
                      {a.name}<span className="text-white/20 ml-1">{a.count}</span>
                    </span>
                  ))}
                </div>
              </section>
            </div>

            {/* 可能想听 */}
            <section className="glass-light rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-[13px] text-white/60">可能想听</h2>
                  {recs?.theme && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/6 text-white/35">
                      主题：{recs.theme}
                    </span>
                  )}
                </div>
                {recs?.generated_at && (
                  <span className="text-[10px] text-white/20">生成于 {fmtTime(recs.generated_at)}</span>
                )}
              </div>

              {recs?.items?.length ? (
                <div className="grid md:grid-cols-2 gap-3">
                  {recs.items.map((p, i) => <PickCard key={`${p.title}-${i}`} pick={p} />)}
                </div>
              ) : (
                <div className="py-8 text-center space-y-2">
                  <p className="text-[12px] text-white/35">还没有推荐</p>
                  <button onClick={regenerate} disabled={recBusy}
                    className="px-4 py-2 rounded-xl text-[12px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40">
                    {recBusy ? '生成中…（约 10-20 秒）' : '生成 8 首'}
                  </button>
                </div>
              )}

              <p className="text-[10px] text-white/15 mt-3 leading-relaxed">
                推荐由口味画像 + 随机场景生成，并逐条到网易云校验；标「未校验」的表示没搜到，
                链接会打开搜索结果页。曲库里已有的歌会被过滤掉。
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
