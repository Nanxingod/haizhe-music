// 设置页 - 背景DIY + 字体DIY + 人声分离缓存管理

import { useState, useEffect, useCallback, memo } from 'react';
import { api } from '../api';
import { usePlayer } from '../store';
import type { StemItem } from '../types';
import { applyBgStyle, type BgAdjust } from '../App';

type BgArea = 'main' | 'sidebar' | 'player';

interface BgItem { name: string; file?: string; path: string; custom?: boolean; }
interface BgConfig { main: string; sidebar: string; player: string; }
/** V12.5: 每区域三参调节（遮罩浓度/对比度/模糊），兼容旧纯数字格式 */
type DimConfig = Record<BgArea, BgAdjust>;

/** 侧边栏特殊值：跟随主背景（整 APP 一张图，交界无缝） */
const FOLLOW = 'follow';

const DEFAULT_ADJ: BgAdjust = { dim: 0.3, contrast: 1, blur: 0 };
const DEFAULT_ADJ_SIDE: BgAdjust = { dim: 0.55, contrast: 1, blur: 0 };

const DEFAULTS: BgConfig = {
  main: '/bg/main/bg-main.png',
  sidebar: 'follow',
  player: '/bg/player/bg-player.png',
};

/** 读取并迁移旧格式（number → BgAdjust） */
function loadDimConfig(): DimConfig {
  const fb: DimConfig = { main: DEFAULT_ADJ, sidebar: DEFAULT_ADJ_SIDE, player: DEFAULT_ADJ_SIDE };
  try {
    const s = localStorage.getItem('haizhe-dim');
    if (!s) return fb;
    const raw = JSON.parse(s);
    const out = {} as DimConfig;
    (['main', 'sidebar', 'player'] as BgArea[]).forEach(a => {
      const r = raw[a];
      if (typeof r === 'number') out[a] = { ...fb[a], dim: r };
      else if (r && typeof r === 'object') out[a] = { dim: r.dim ?? fb[a].dim, contrast: r.contrast ?? 1, blur: r.blur ?? 0 };
      else out[a] = fb[a];
    });
    return out;
  } catch { return fb; }
}

const LABELS: Record<BgArea, string> = {
  main: '主页面', sidebar: '侧边栏', player: '播放页',
};

// ── 字体选项 ──
const FONT_OPTIONS: { id: string; name: string; css: string; preview: string }[] = [
  { id: 'noto-sans', name: '思源黑体', css: "'Noto Sans SC', 'PingFang SC', sans-serif", preview: '现代简洁' },
  { id: 'noto-serif', name: '思源宋体', css: "'Noto Serif SC', 'Songti SC', serif", preview: '优雅衬线' },
  { id: 'kuaile', name: '快乐圆体', css: "'ZCOOL KuaiLe', sans-serif", preview: '活泼圆润' },
  { id: 'xiaowei', name: '小薇体', css: "'ZCOOL XiaoWei', serif", preview: '文艺清新' },
  { id: 'mashan', name: '马山手写', css: "'Ma Shan Zheng', cursive", preview: '书法手写' },
  { id: 'zhimang', name: '志莽行楷', css: "'Zhi Mang Xing', cursive", preview: '飘逸行书' },
  { id: 'liujian', name: '柳笺草书', css: "'Liu Jian Mao Cao', cursive", preview: '写意草书' },
  { id: 'longcang', name: '龙藏体', css: "'Long Cang', cursive", preview: '古朴手写' },
];

export const SettingsPage = memo(function SettingsPage() {
  const { state, dispatch } = usePlayer();
  // 状态
  const [bg, setBg] = useState<BgConfig>(() => {
    try { const s = localStorage.getItem('haizhe-bg'); return s ? { ...DEFAULTS, ...JSON.parse(s) } : DEFAULTS; }
    catch { return DEFAULTS; }
  });
  const [dim, setDim] = useState<DimConfig>(loadDimConfig);
  const [imageLists, setImageLists] = useState<Record<BgArea, BgItem[]>>({ main: [], sidebar: [], player: [] });
  const [uploading, setUploading] = useState<Record<BgArea, boolean>>({ main: false, sidebar: false, player: false });
  const [uiFont, setUiFont] = useState(() => localStorage.getItem('haizhe-font-ui') || 'noto-sans');
  const [lyricsFont, setLyricsFont] = useState(() => localStorage.getItem('haizhe-font-lyrics') || 'noto-serif');
  const [headingFont, setHeadingFont] = useState(() => localStorage.getItem('haizhe-font-heading') || 'noto-sans');
  // PiP 桌面歌词样式
  const [pipBg, setPipBg] = useState(() => Number(localStorage.getItem('haizhe-pip-bg') || 0.75));
  const [pipColor, setPipColor] = useState(() => localStorage.getItem('haizhe-pip-color') || '#ff9eaf');
  const [pipSize, setPipSize] = useState(() => Number(localStorage.getItem('haizhe-pip-size') || 20));
  // 人声分离缓存
  const [stemsAvail, setStemsAvail] = useState(true);
  const [stemsItems, setStemsItems] = useState<StemItem[]>([]);
  const [songNames, setSongNames] = useState<Record<string, { title: string; artist: string }>>({});
  // 音乐目录
  const [musicDir, setMusicDir] = useState('');
  const [dirInput, setDirInput] = useState('');
  const [dirBusy, setDirBusy] = useState(false); // 保存中（含重扫）
  const [dirMsg, setDirMsg] = useState('');

  useEffect(() => {
    fetch('/api/config').then(r => r.json())
      .then((c: { music_dir: string }) => { setMusicDir(c.music_dir); setDirInput(c.music_dir); })
      .catch(() => {});
  }, []);

  const saveMusicDir = async (dir: string) => {
    const d = dir.trim();
    if (!d || d === musicDir || dirBusy) return;
    setDirBusy(true); setDirMsg('');
    try {
      const res = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ music_dir: d }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `切换失败 (${res.status})`);
      setMusicDir(data.music_dir);
      setDirMsg(`已切换，扫描到 ${data.songs} 首歌`);
      loadStems(); // 新曲库的分离缓存列表
      dispatch({ type: 'PAUSE' }); // 旧曲库的歌停止播放（避免播完 404 跳歌）
    } catch (e) {
      setDirMsg(`失败：${(e as Error).message}`);
    } finally {
      setDirBusy(false);
    }
  };

  const pickDir = async () => {
    const ea = (window as any).electronAPI;
    if (!ea?.pickMusicDir) return;
    const dir = await ea.pickMusicDir();
    if (dir) saveMusicDir(dir);
  };

  const loadStems = useCallback(() => {
    api.listStems().then(d => { setStemsAvail(d.available); setStemsItems(d.items); }).catch(() => {});
  }, []);

  useEffect(() => {
    loadStems();
    api.getSongs('', 1000).then(d => {
      const m: Record<string, { title: string; artist: string }> = {};
      d.songs.forEach((s: { id: string; title: string; artist: string }) => { m[s.id] = { title: s.title, artist: s.artist }; });
      setSongNames(m);
    }).catch(() => {});
  }, [loadStems]);

  const deleteStem = async (id: string) => {
    // 正在播放该歌的分离音轨时先切回原唱，避免 stream 404 触发跳歌
    if (state.currentSong?.id === id && state.stem !== 'original') {
      dispatch({ type: 'SET_STEM', stem: 'original' });
    }
    await api.deleteStems(id).catch(() => {});
    loadStems();
  };

  // 加载文件夹图片
  useEffect(() => {
    (['main', 'sidebar', 'player'] as BgArea[]).forEach(area => {
      fetch(`/api/bg-images/${area}`).then(r => r.json())
        .then(list => setImageLists(prev => ({ ...prev, [area]: list }))).catch(() => {});
    });
  }, []);

  // 应用背景 + 调节参数（与启动时 App.tsx BackgroundInit 同一实现）
  useEffect(() => {
    const follow = bg.sidebar === FOLLOW;
    applyBgStyle('main', bg.main, dim.main);
    applyBgStyle('sidebar', follow ? bg.main : bg.sidebar, dim.sidebar,
      { followMain: follow, mainAdj: dim.main });
    applyBgStyle('player', bg.player, dim.player);
    localStorage.setItem('haizhe-bg', JSON.stringify(bg));
    localStorage.setItem('haizhe-dim', JSON.stringify(dim));
  }, [bg, dim]);

  // 应用字体
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--font-ui', FONT_OPTIONS.find(f => f.id === uiFont)?.css || '');
    root.style.setProperty('--font-lyrics', FONT_OPTIONS.find(f => f.id === lyricsFont)?.css || '');
    root.style.setProperty('--font-heading', FONT_OPTIONS.find(f => f.id === headingFont)?.css || '');
    localStorage.setItem('haizhe-font-ui', uiFont);
    localStorage.setItem('haizhe-font-lyrics', lyricsFont);
    localStorage.setItem('haizhe-font-heading', headingFont);
  }, [uiFont, lyricsFont, headingFont]);

  const selectImage = (area: BgArea, path: string) => setBg(prev => ({ ...prev, [area]: path }));

  // 重新拉取某区域的图片列表
  const reloadImages = useCallback((area: BgArea) => {
    fetch(`/api/bg-images/${area}`).then(r => r.json())
      .then((list: BgItem[]) => setImageLists(prev => ({ ...prev, [area]: list }))).catch(() => {});
  }, []);

  const handleUpload = async (area: BgArea, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    setUploading(prev => ({ ...prev, [area]: true }));
    try {
      const res = await fetch(`/api/bg-images/${area}?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `上传失败 (${res.status})`));
      const item: BgItem = await res.json();
      setImageLists(prev => ({ ...prev, [area]: [...prev[area], item] }));
      setBg(prev => ({ ...prev, [area]: item.path })); // 上传后立即应用
    } catch (err) {
      alert(`背景图上传失败：${(err as Error).message}`);
    } finally {
      setUploading(prev => ({ ...prev, [area]: false }));
    }
  };

  const handleDeleteBg = async (area: BgArea, item: BgItem) => {
    if (!item.custom || !item.file) return;
    if (!confirm(`删除自定义背景"${item.name}"？`)) return;
    const ok = await fetch(`/api/bg-images/${area}/${encodeURIComponent(item.file)}`, { method: 'DELETE' })
      .then(r => r.ok).catch(() => false);
    if (ok) {
      // 若删除的是当前使用的背景，回落到默认
      setBg(prev => prev[area] === item.path ? { ...prev, [area]: DEFAULTS[area] } : prev);
      reloadImages(area);
    }
  };
  // 侧边栏 跟随/独立 切换（关闭时回落到默认独立图路径，不能引用 DEFAULTS.sidebar——它就是 'follow'）
  const toggleFollow = () => {
    setBg(prev => ({ ...prev, sidebar: prev.sidebar === FOLLOW ? '/bg/sidebar/bg-sidebar.png' : FOLLOW }));
  };

  const resetAll = () => {
    setBg(DEFAULTS); setDim({ main: DEFAULT_ADJ, sidebar: DEFAULT_ADJ_SIDE, player: DEFAULT_ADJ_SIDE });
    setUiFont('noto-sans'); setLyricsFont('noto-serif'); setHeadingFont('noto-sans');
    localStorage.clear();
  };

  // 字体选择器组件
  const FontPicker = ({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) => (
    <div className="space-y-2">
      <p className="text-xs text-white/40">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {FONT_OPTIONS.map(f => (
          <button key={f.id}
            onClick={() => onChange(f.id)}
            className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
              value === f.id
                ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/25'
                : 'bg-white/5 text-white/35 hover:bg-white/10 hover:text-white/55'
            }`}
            style={{ fontFamily: f.css }}
          >
            {f.preview}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 glass border-b border-white/5 px-8 py-5 max-md:px-4">
        <h1 className="text-2xl font-bold max-md:text-xl">设置</h1>
        <p className="text-white/30 text-sm mt-0.5">外观 DIY</p>
      </div>

      <div className="px-8 py-6 max-w-3xl space-y-8 max-md:px-4">

        {/* ═══ 音乐目录 ═══ */}
        <section className="glass-light rounded-2xl p-5 space-y-3">
          <h2 className="text-lg font-semibold">🎵 音乐目录</h2>
          <div className="flex items-center gap-2">
            <input
              type="text" value={dirInput} onChange={e => setDirInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveMusicDir(dirInput)}
              placeholder="D:\Music\我的歌曲"
              className="flex-1 bg-black/30 backdrop-blur-md border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/20 outline-none focus:border-[var(--accent)] transition-colors"
            />
            {(window as any).electronAPI?.pickMusicDir && (
              <button onClick={pickDir} disabled={dirBusy}
                className="px-4 py-2.5 rounded-xl text-sm bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50 shrink-0">
                浏览…
              </button>
            )}
            <button onClick={() => saveMusicDir(dirInput)} disabled={dirBusy || dirInput.trim() === musicDir}
              className="px-4 py-2.5 rounded-xl text-sm bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40 shrink-0">
              {dirBusy ? '扫描中…' : '保存'}
            </button>
          </div>
          {dirMsg && <p className={`text-xs ${dirMsg.startsWith('失败') ? 'text-red-300/70' : 'text-[var(--accent)]/80'}`}>{dirMsg}</p>}
          <p className="text-xs text-white/25 leading-relaxed">
            切换后立即重新扫描。人声分离结果保存在音乐目录下的「人声分离」文件夹，随曲库一起备份/迁移。
          </p>
        </section>

        {/* ═══ 背景图 ═══ */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">🖼️ 背景图</h2>

          {/* 横向三列预览 */}
          <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
            {(['main', 'sidebar', 'player'] as BgArea[]).map(area => {
              const follow = area === 'sidebar' && bg.sidebar === FOLLOW;
              const previewUrl = follow ? bg.main : bg[area];
              // follow 时图片参数预览复用主图的（真实渲染行为一致）
              const a = follow ? dim.main : dim[area];
              const upd = (patch: Partial<BgAdjust>) => setDim(prev => ({ ...prev, [area]: { ...prev[area], ...patch } }));
              return (
              <div key={area} className="glass-light rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-white/50">{LABELS[area]}</p>
                  {area === 'sidebar' && (
                    <button onClick={toggleFollow}
                      className={`px-2 py-1 rounded text-[11px] transition-colors ${
                        follow ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/50'}`}
                      title="侧边栏直接使用主背景图，交界处无缝融合">
                      {follow ? '🔗 跟随主背景' : '跟随主背景'}
                    </button>
                  )}
                </div>
                <div className="w-full aspect-video rounded-lg border border-white/10 overflow-hidden"
                  style={{
                    backgroundImage: `url('${previewUrl}')`,
                    backgroundSize: 'cover', backgroundPosition: 'center',
                    filter: `brightness(${1 - a.dim * 0.8}) contrast(${a.contrast ?? 1})${a.blur ? ` blur(${a.blur}px)` : ''}`,
                  }}
                />
                {/* 遮罩浓度 */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/30 w-11 shrink-0">{follow ? '遮罩' : '明暗'}</span>
                  <input type="range" min={0.1} max={0.9} step={0.05} value={dim[area].dim}
                    onChange={e => upd({ dim: Number(e.target.value) })}
                    className="progress-bar flex-1"
                    style={{ backgroundImage: `linear-gradient(to right, var(--accent) ${((dim[area].dim-0.1)/0.8)*100}%, rgba(255,255,255,0.06) ${((dim[area].dim-0.1)/0.8)*100}%)` }}
                  />
                </div>
                {/* 对比度 */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/30 w-11 shrink-0">对比</span>
                  <input type="range" min={0.6} max={1.6} step={0.05} value={dim[area].contrast ?? 1}
                    onChange={e => upd({ contrast: Number(e.target.value) })}
                    className="progress-bar flex-1"
                    style={{ backgroundImage: `linear-gradient(to right, var(--accent) ${(((dim[area].contrast ?? 1)-0.6)/1)*100}%, rgba(255,255,255,0.06) ${(((dim[area].contrast ?? 1)-0.6)/1)*100}%)` }}
                  />
                </div>
                {/* 模糊 */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/30 w-11 shrink-0">模糊</span>
                  <input type="range" min={0} max={16} step={0.5} value={dim[area].blur ?? 0}
                    onChange={e => upd({ blur: Number(e.target.value) })}
                    className="progress-bar flex-1"
                    style={{ backgroundImage: `linear-gradient(to right, var(--accent) ${((dim[area].blur ?? 0)/16)*100}%, rgba(255,255,255,0.06) ${((dim[area].blur ?? 0)/16)*100}%)` }}
                  />
                </div>
                {/* 图片选择 + 上传（follow 模式下隐藏，图片跟随主页面） */}
                {follow ? (
                  <p className="text-[11px] text-white/25 leading-relaxed">
                    正在使用主页面背景，交界处无缝融合。再点一次"跟随主背景"可切回独立图片。
                  </p>
                ) : (
                <div className="flex flex-wrap gap-1">
                  {imageLists[area].map(img => (
                    <span key={img.path}
                      className={`group inline-flex items-center rounded text-[11px] transition-all overflow-hidden ${
                        bg[area] === img.path
                          ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/20'
                          : 'bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/50'
                      }`}>
                      <button onClick={() => selectImage(area, img.path)} className="px-2 py-1 max-w-[120px] truncate">
                        {img.custom ? '📌 ' : ''}{img.name.length > 10 ? img.name.slice(0, 9) + '…' : img.name}
                      </button>
                      {img.custom && img.file && (
                        <button onClick={() => handleDeleteBg(area, img)} title="删除此自定义背景"
                          className="px-1.5 py-1 text-white/20 hover:text-red-300 transition-colors">✕</button>
                      )}
                    </span>
                  ))}
                  <label className="px-3 py-1 rounded text-[11px] cursor-pointer bg-white/5 text-white/35 hover:bg-white/10 hover:text-white/60 border border-dashed border-white/15 transition-colors"
                    title="添加自定义背景图">
                    {uploading[area] ? '上传中…' : '+ 添加'}
                    <input type="file" accept="image/*" className="hidden"
                      onChange={e => handleUpload(area, e)} disabled={uploading[area]} />
                  </label>
                </div>
                )}
              </div>
              );
            })}
          </div>

          <p className="text-xs text-white/20 leading-relaxed">
            明暗 = 整体压暗程度 · 对比 = 拉开图片明暗反差 · 模糊 = 背景糊化（文字与图同色时最有效）
          </p>
        </section>

        {/* ═══ 字体 ═══ */}
        <section className="glass-light rounded-2xl p-5 space-y-5">
          <h2 className="text-lg font-semibold">✍️ 字体</h2>
          <FontPicker label="界面字体（按钮、列表、导航）" value={uiFont} onChange={setUiFont} />
          <FontPicker label="标题字体（页面标题）" value={headingFont} onChange={setHeadingFont} />
          <FontPicker label="歌词字体（播放页 + 悬浮窗）" value={lyricsFont} onChange={setLyricsFont} />
          <p className="text-xs text-white/20">所有字体来自 Google Fonts，需要联网加载。切换即时生效。</p>
        </section>

        {/* ═══ 桌面歌词悬浮窗样式 ═══ */}
        <section className="glass-light rounded-2xl p-5 space-y-4">
          <h2 className="text-lg font-semibold">🪟 桌面歌词悬浮窗</h2>
          
          {/* 背景深浅 */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/40 w-16 shrink-0">背景深浅</span>
            <input type="range" min={0} max={0.95} step={0.05} value={pipBg}
              onChange={e => { const v = Number(e.target.value); setPipBg(v); localStorage.setItem('haizhe-pip-bg', String(v)); }}
              className="progress-bar flex-1"
              style={{ backgroundImage: `linear-gradient(to right, transparent ${(pipBg/0.95)*100}%, rgba(0,0,0,1) ${(pipBg/0.95)*100}%)` }}
            />
            <div className="w-6 h-6 rounded border border-white/10 shrink-0" style={{ background: `rgba(0,0,0,${pipBg})` }} />
          </div>

          {/* 字体颜色 */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/40 w-16 shrink-0">字体颜色</span>
            <input type="color" value={pipColor}
              onChange={e => { setPipColor(e.target.value); localStorage.setItem('haizhe-pip-color', e.target.value); }}
              className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent"
            />
            <span className="text-xs text-white/25">{pipColor}</span>
          </div>

          {/* 字体大小 */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/40 w-16 shrink-0">字体大小</span>
            <input type="range" min={14} max={36} step={1} value={pipSize}
              onChange={e => { const v = Number(e.target.value); setPipSize(v); localStorage.setItem('haizhe-pip-size', String(v)); }}
              className="progress-bar flex-1"
              style={{ backgroundImage: `linear-gradient(to right, var(--accent) ${((pipSize-14)/22)*100}%, rgba(255,255,255,0.06) ${((pipSize-14)/22)*100}%)` }}
            />
            <span className="text-xs text-white/40 w-6 text-right">{pipSize}px</span>
          </div>

          {/* 预览 */}
          <div className="rounded-xl overflow-hidden border border-white/10" style={{ background: `rgba(0,0,0,${pipBg})` }}>
            <p className="text-center py-4 font-semibold transition-all"
              style={{ color: pipColor, fontSize: pipSize + 'px', fontFamily: FONT_OPTIONS.find(f => f.id === lyricsFont)?.css, textShadow: `0 0 10px ${pipColor}44` }}>
              预览效果 Preview
            </p>
          </div>

          <p className="text-xs text-white/20">修改后需重新开启悬浮窗生效。歌词字体跟随上方「歌词字体」设置。</p>
        </section>

        {/* ═══ 人声分离缓存 ═══ */}
        <section className="glass-light rounded-2xl p-5 space-y-4">
          <h2 className="text-lg font-semibold">🎤 人声分离缓存</h2>
          {!stemsAvail ? (
            <p className="text-xs text-white/30 leading-relaxed">
              后端未安装 audio-separator，人声/伴奏分离不可用。<br />
              安装：在 backend 目录运行 <code className="text-white/50 bg-white/10 px-1.5 py-0.5 rounded">pip install audio-separator</code> 后重启播放器。
            </p>
          ) : stemsItems.length === 0 ? (
            <p className="text-xs text-white/30">暂无分离缓存。在播放栏"效果"面板中可以对当前歌曲做人声/伴奏分离。</p>
          ) : (
            <div className="space-y-1.5">
              {stemsItems.map(it => (
                <div key={it.song_id} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-white/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{songNames[it.song_id]?.title || it.song_id}</p>
                    <p className="text-[11px] text-white/25 truncate">
                      {songNames[it.song_id]?.artist || '未知歌手'} · {it.size_mb} MB
                      {it.quality === 'hq' && <span className="text-[var(--accent)]/70"> · 高质量</span>}
                    </p>
                  </div>
                  <button onClick={() => deleteStem(it.song_id)}
                    className="text-xs text-white/30 hover:text-red-300 transition-colors shrink-0">删除</button>
                </div>
              ))}
              <p className="text-xs text-white/20 pt-1">
                共 {stemsItems.length} 首 · {stemsItems.reduce((a, b) => a + b.size_mb, 0).toFixed(1)} MB
              </p>
            </div>
          )}
        </section>

        <button onClick={resetAll} className="text-xs text-white/20 hover:text-white/50 underline transition-colors">
          恢复全部默认
        </button>
      </div>
    </div>
  );
});
