import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { applySkin, currentSkin } from './skin'

// 启动就套上皮肤，避免首屏闪一下默认配色
applySkin(currentSkin())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
