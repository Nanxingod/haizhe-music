// 音乐播放器 - 主应用

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { PlayerProvider } from './store';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { PlayerBar } from './components/PlayerBar';
import { AllSongsPage } from './pages/AllSongsPage';
import { ArtistsPage } from './pages/ArtistsPage';
import { ArtistSongsPage } from './pages/ArtistSongsPage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';

// ⚡ V12.5: 启动时立即应用背景样式（含 follow 模式 / 对比度 / 模糊）
export interface BgAdjust { dim: number; contrast?: number; blur?: number; }

// 旧格式（纯数字 dim）迁移为对象
function migrateDim(raw: unknown, fallback: number): BgAdjust {
  if (typeof raw === 'number') return { dim: raw, contrast: 1, blur: 0 };
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<BgAdjust>;
    return { dim: r.dim ?? fallback, contrast: r.contrast ?? 1, blur: r.blur ?? 0 };
  }
  return { dim: fallback, contrast: 1, blur: 0 };
}

export function applyBgStyle(
  area: string,
  url: string,
  adj: BgAdjust,
  opts?: { followMain?: boolean; mainAdj?: BgAdjust },
) {
  const id = `bg-${area}-style`;
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }

  const follow = area === 'sidebar' && opts?.followMain;
  const filter = `brightness(${1 - adj.dim * 0.8}) contrast(${adj.contrast ?? 1})`
    + (adj.blur ? ` blur(${adj.blur}px)` : '');

  let css = '';
  if (area === 'main') {
    css = `body::before { background-image: url('${url}') !important; filter: ${filter} !important; }`;
  } else if (area === 'sidebar') {
    if (follow) {
      // 跟随模式：禁用侧边栏自己的图片层，body::before 主背景直接透出。
      // 同一张图的同一个渲染结果（连 filter/blurl/cover 几何都完全一致）= 绝对无缝。
      // 不用 background-attachment:fixed 复刻——主背景盒子带 -30px 扩边（blur 防露边），
      // 两边 cover 缩放基准不同会产生约 5% 的"放大"错位。
      css = `.sidebar-bg::before { background-image: none !important; }`;
    } else {
      css = `.sidebar-bg::before { background-image: url('${url}') !important; filter: ${filter} !important; }`;
    }
    const d = adj.dim;
    const left = Math.min(0.92, d + 0.3);
    const mid = d + 0.08;
    // 跟随：遮罩右端归零（浓度与主区域连续）；独立图：右端保持基础遮罩
    const right = follow ? 0 : Math.max(0.15, d - 0.12);
    css += `.sidebar-bg::after { background: linear-gradient(to right, rgba(8,8,22,${left}) 0%, rgba(8,8,22,${mid}) 55%, rgba(8,8,22,${right}) 100%) !important; }`;
  } else {
    css = `.player-bg::before { background-image: url('${url}') !important; filter: ${filter} !important; }`;
  }
  el.textContent = css;
}

/** 默认配置：新装机侧边栏即跟随主背景（整 APP 一张图） */
export const BG_DEFAULTS: Record<string, string> = {
  main: '/bg/main/bg-main.png',
  sidebar: 'follow',
  player: '/bg/player/bg-player.png',
};

function BackgroundInit() {
  useEffect(() => {
    try {
      // 总是应用：无 localStorage 时用默认（sidebar=follow），保证新装机开箱即整图
      const bgStr = localStorage.getItem('haizhe-bg');
      const dimStr = localStorage.getItem('haizhe-dim');
      const bg = bgStr ? JSON.parse(bgStr) : {};
      const dimRaw = dimStr ? JSON.parse(dimStr) : {};
      const areas = ['main', 'sidebar', 'player'] as const;
      const adjs: Record<string, BgAdjust> = {};
      areas.forEach(area => {
        adjs[area] = migrateDim(dimRaw[area], area === 'main' ? 0.3 : 0.55);
      });
      const mainUrl = bg.main || BG_DEFAULTS.main;
      areas.forEach(area => {
        const follow = area === 'sidebar' && (bg.sidebar ?? BG_DEFAULTS.sidebar) === 'follow';
        const url = follow ? mainUrl : (bg[area] || BG_DEFAULTS[area]);
        applyBgStyle(area, url, adjs[area], { followMain: follow, mainAdj: adjs.main });
      });
    } catch {}
  }, []);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <PlayerProvider>
        <BackgroundInit />
        <div className="h-full flex flex-col overflow-hidden">
          <TitleBar />
          <div className="flex flex-1 overflow-hidden relative">
            <Sidebar />
            <main className="flex-1 overflow-hidden flex flex-col relative">
              <Routes>
                <Route path="/" element={<AllSongsPage />} />
                <Route path="/artists" element={<ArtistsPage />} />
                <Route path="/artist/:name" element={<ArtistSongsPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </main>
          </div>
          <div className="relative shrink-0">
            <PlayerBar />
          </div>
        </div>
      </PlayerProvider>
    </BrowserRouter>
  );
}
