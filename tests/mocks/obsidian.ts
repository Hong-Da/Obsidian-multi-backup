// obsidian 包只有类型声明，单元测试用这里的最小实现代替（vitest.config.ts 中配置别名）
export function getLanguage(): string {
  return "en";
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
