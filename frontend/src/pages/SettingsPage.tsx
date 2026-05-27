// 设置页 - 背景DIY + 字体DIY

import { useState, useEffect, memo } from 'react';

type BgArea = 'main' | 'sidebar' | 'player';

interface BgItem { name: string; path: string; }
interface BgConfig { main: string; sidebar: string; player: string; }
interface DimConfig { main: number; sidebar: number; player: number; }

const DEFAULTS: BgConfig = {
  main: '/bg/main/bg-main.png',
  sidebar: '/bg/sidebar/bg-sidebar.png',
  player: '/bg/player/bg-player.png',
};

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
  // 状态
  const [bg, setBg] = useState<BgConfig>(() => {
    try { const s = localStorage.getItem('haizhe-bg'); return s ? { ...DEFAULTS, ...JSON.parse(s) } : DEFAULTS; }
    catch { return DEFAULTS; }
  });
  const [dim, setDim] = useState<DimConfig>(() => {
    try { const s = localStorage.getItem('haizhe-dim'); return s ? JSON.parse(s) : { main: 0.3, sidebar: 0.55, player: 0.55 }; }
    catch { return { main: 0.3, sidebar: 0.55, player: 0.55 }; }
  });
  const [imageLists, setImageLists] = useState<Record<BgArea, BgItem[]>>({ main: [], sidebar: [], player: [] });
  const [uiFont, setUiFont] = useState(() => localStorage.getItem('haizhe-font-ui') || 'noto-sans');
  const [lyricsFont, setLyricsFont] = useState(() => localStorage.getItem('haizhe-font-lyrics') || 'noto-serif');
  const [headingFont, setHeadingFont] = useState(() => localStorage.getItem('haizhe-font-heading') || 'noto-sans');
  // PiP 桌面歌词样式
  const [pipBg, setPipBg] = useState(() => Number(localStorage.getItem('haizhe-pip-bg') || 0.75));
  const [pipColor, setPipColor] = useState(() => localStorage.getItem('haizhe-pip-color') || '#ff9eaf');
  const [pipSize, setPipSize] = useState(() => Number(localStorage.getItem('haizhe-pip-size') || 20));

  // 加载文件夹图片
  useEffect(() => {
    (['main', 'sidebar', 'player'] as BgArea[]).forEach(area => {
      fetch(`/api/bg-images/${area}`).then(r => r.json())
        .then(list => setImageLists(prev => ({ ...prev, [area]: list }))).catch(() => {});
    });
  }, []);

  // 应用背景 + 亮度
  useEffect(() => {
    applyBg('main', bg.main, dim.main);
    applyBg('sidebar', bg.sidebar, dim.sidebar);
    applyBg('player', bg.player, dim.player);
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
  const handleUpload = (area: BgArea, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const url = URL.createObjectURL(file);
    setBg(prev => ({ ...prev, [area]: url }));
    setImageLists(prev => ({ ...prev, [area]: [...prev[area], { name: '📁 ' + file.name, path: url }] }));
  };
  const resetAll = () => {
    setBg(DEFAULTS); setDim({ main: 0.3, sidebar: 0.55, player: 0.55 });
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

        {/* ═══ 背景图 ═══ */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">🖼️ 背景图</h2>

          {/* 横向三列预览 */}
          <div className="grid grid-cols-3 gap-4 max-md:grid-cols-1">
            {(['main', 'sidebar', 'player'] as BgArea[]).map(area => (
              <div key={area} className="glass-light rounded-xl p-4 space-y-3">
                <p className="text-sm text-white/50">{LABELS[area]}</p>
                <div className="w-full aspect-video rounded-lg border border-white/10 overflow-hidden"
                  style={{
                    backgroundImage: `url('${bg[area]}')`,
                    backgroundSize: 'cover', backgroundPosition: 'center',
                    filter: `brightness(${1 - dim[area] * 0.8})`,
                  }}
                />
                {/* 亮度滑块 */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/25">🌙</span>
                  <input type="range" min={0.1} max={0.9} step={0.05} value={dim[area]}
                    onChange={e => setDim(prev => ({ ...prev, [area]: Number(e.target.value) }))}
                    className="progress-bar flex-1"
                    style={{ background: `linear-gradient(to right, var(--accent) ${((dim[area]-0.1)/0.8)*100}%, rgba(255,255,255,0.06) ${((dim[area]-0.1)/0.8)*100}%)` }}
                  />
                  <span className="text-xs text-white/25">☀️</span>
                </div>
                {/* 图片选择 */}
                <div className="flex flex-wrap gap-1">
                  {imageLists[area].map(img => (
                    <button key={img.path}
                      onClick={() => selectImage(area, img.path)}
                      className={`px-2 py-1 rounded text-[11px] transition-all ${
                        bg[area] === img.path
                          ? 'bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/20'
                          : 'bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/50'
                      }`}
                    >{img.name.length > 10 ? img.name.slice(0,9)+'…' : img.name}</button>
                  ))}
                  <label className="px-2 py-1 rounded text-[11px] cursor-pointer bg-white/5 text-white/25 hover:bg-white/10 border border-dashed border-white/8">+</label>
                  <input type="file" accept="image/*" className="hidden" onChange={e => handleUpload(area, e)} />
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-white/20">
            🌙 越暗 = 背景越深、文字越突出 &nbsp;|&nbsp; ☀️ 越亮 = 背景越清晰
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
              style={{ background: `linear-gradient(to right, transparent ${(pipBg/0.95)*100}%, rgba(0,0,0,1) ${(pipBg/0.95)*100}%)` }}
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
              style={{ background: `linear-gradient(to right, var(--accent) ${((pipSize-14)/22)*100}%, rgba(255,255,255,0.06) ${((pipSize-14)/22)*100}%)` }}
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

        <button onClick={resetAll} className="text-xs text-white/20 hover:text-white/50 underline transition-colors">
          恢复全部默认
        </button>
      </div>
    </div>
  );
});

// ── 应用背景：直接操作 DOM ──
function applyBg(area: BgArea, url: string, dimVal: number) {
  const id = `bg-${area}-style`;
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }

  const selectors: Record<BgArea, string> = {
    main: 'body::before',
    sidebar: '.sidebar-bg',
    player: '.player-bg',
  };
  const brightness = 1 - dimVal * 0.8;

  el.textContent = `${selectors[area]} {
    background-image: url('${url}') !important;
    filter: brightness(${brightness}) saturate(1) !important;
  }`;
  // sidebar 需要额外保持遮罩层不变
  if (area === 'sidebar') {
    el.textContent += `.sidebar-bg::before { background: rgba(10,10,25,${dimVal}) !important; }`;
  }
}
