// 桌词锁定状态的单一来源（V14.6）
//
// 为什么需要这层：锁定可以在"桌词窗口"里点，也可以在主窗口点，
// 但状态必须三处同步（主窗口提示条 / 底栏角标 / 设置页开关）。
// 做法：localStorage 存值 + 自定义事件广播 + 主进程回推（桌词端点的锁）。

export const PIP_LOCK_KEY = 'haizhe-pip-lock';
export const PIP_LOCK_EVENT = 'haizhe-pip-lock';

export function isPipLocked(): boolean {
  try { return localStorage.getItem(PIP_LOCK_KEY) === '1'; } catch { return false; }
}

/** 改锁定状态：写本地 + 通知主进程 + 广播给所有 UI */
export function setPipLocked(v: boolean) {
  try { localStorage.setItem(PIP_LOCK_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  (window as any).electronAPI?.lyricLock?.(v);
  window.dispatchEvent(new CustomEvent(PIP_LOCK_EVENT, { detail: v }));
}

/**
 * 订阅主进程回推（在桌词窗口里点的锁会经由 main 转回来）。
 * 返回取消订阅函数。
 */
export function bindPipLockSync(): () => void {
  const api = (window as any).electronAPI;
  if (!api?.onLyricLockState) return () => {};
  return api.onLyricLockState((v: boolean) => {
    try { localStorage.setItem(PIP_LOCK_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(PIP_LOCK_EVENT, { detail: v }));
  });
}
