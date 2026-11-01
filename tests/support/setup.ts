// 所有测试的公共准备：Node 里没有 window，插件代码用 window.setTimeout 等定时器，这里指向全局对象。
if (typeof window === "undefined") Object.assign(globalThis, { window: globalThis });
