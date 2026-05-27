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

// ⚡ V10.1: 启动时立即应用背景样式（之前只在进入设置页时才生效）
function BackgroundInit() {
  useEffect(() => {
    try {
      const bgStr = localStorage.getItem('haizhe-bg');
      const dimStr = localStorage.getItem('haizhe-dim');
      if (!bgStr && !dimStr) return;
      const bg = bgStr ? JSON.parse(bgStr) : {};
      const dim = dimStr ? JSON.parse(dimStr) : {};
      const areas = ['main', 'sidebar', 'player'] as const;
      const defaults: Record<string, string> = {
        main: '/bg/main/bg-main.png',
        sidebar: '/bg/sidebar/bg-sidebar.png',
        player: '/bg/player/bg-player.png',
      };
      areas.forEach(area => {
        const url = bg[area] || defaults[area];
        const dimVal = dim[area] ?? (area === 'main' ? 0.3 : 0.55);
        applyBgStyle(area, url, dimVal);
      });
    } catch {}
  }, []);
  return null;
}

function applyBgStyle(area: string, url: string, dimVal: number) {
  const id = `bg-${area}-style`;
  let el = document.getElementById(id);
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  const selectors: Record<string, string> = {
    main: 'body::before',
    sidebar: '.sidebar-bg',
    player: '.player-bg',
  };
  const brightness = 1 - dimVal * 0.8;
  let css = `${selectors[area]} { background-image: url('${url}') !important; filter: brightness(${brightness}) saturate(1) !important; }`;
  if (area === 'sidebar') {
    css += `.sidebar-bg::before { background: rgba(10,10,25,${dimVal}) !important; }`;
  }
  el.textContent = css;
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
