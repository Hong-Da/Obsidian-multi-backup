// 等待与让出主线程（用 window 的定时器，弹出窗口也能用；Node 测试里由 tests/support/setup.ts 提供 window）。

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** 让出主线程，让界面有机会响应 */
export const yieldToUi = (): Promise<void> => sleep(0);
