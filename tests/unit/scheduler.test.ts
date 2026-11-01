import { describe, expect, it } from "vitest";
import { dueDestinations, lastOccurrence, type AutoConfig } from "../../src/core/scheduler";
import { defaultAuto } from "../../src/settings";

const at = (h: number, m = 0, day = 31) => new Date(2026, 9, day, h, m).getTime();
const dest = (id: string, role: "primary" | "backup" | "zip", patch: Partial<AutoConfig["auto"]> = {}): AutoConfig => ({ id, enabled: true, auto: { ...defaultAuto(role), ...patch } });
const ids = (r: { id: string; reason: string }[]) => r.map((x) => `${x.id}:${x.reason}`);

describe("自动同步的触发", () => {
  it("启动时：只同步开了“启动时”的目的地", () => {
    const r = dueDestinations([dest("p", "primary"), dest("b", "backup")], { now: at(9), lastSync: { p: at(8, 59), b: at(8, 59) }, lastEdit: 0, startup: true });
    expect(ids(r)).toEqual(["p:startup"]);
  });

  it("定时：满了间隔才同步", () => {
    const d = [dest("b", "backup")];
    expect(dueDestinations(d, { now: at(10, 29), lastSync: { b: at(10) }, lastEdit: 0, startup: false })).toEqual([]);
    expect(ids(dueDestinations(d, { now: at(10, 30), lastSync: { b: at(10) }, lastEdit: 0, startup: false }))).toEqual(["b:interval"]);
  });

  it("修改后：停止编辑满 30 秒、且编辑发生在上次同步之后才同步", () => {
    const d = [dest("p", "primary", { interval: { on: false, minutes: 10 } })];
    const base = { lastSync: { p: at(10) }, startup: false };
    expect(dueDestinations(d, { ...base, now: at(10, 5) + 20_000, lastEdit: at(10, 5) })).toEqual([]);
    expect(ids(dueDestinations(d, { ...base, now: at(10, 5) + 30_000, lastEdit: at(10, 5) }))).toEqual(["p:edit"]);
    // 编辑早于上次同步：已经同步过了
    expect(dueDestinations(d, { ...base, now: at(10, 5), lastEdit: at(9, 59) })).toEqual([]);
  });

  it("每天固定时间：到点后同步一次，当天不再重复", () => {
    const d = [dest("z", "zip")];
    expect(dueDestinations(d, { now: at(22, 59), lastSync: { z: at(9) }, lastEdit: 0, startup: false })).toEqual([]);
    expect(ids(dueDestinations(d, { now: at(23, 0), lastSync: { z: at(9) }, lastEdit: 0, startup: false }))).toEqual(["z:daily"]);
    expect(dueDestinations(d, { now: at(23, 30), lastSync: { z: at(23, 1) }, lastEdit: 0, startup: false })).toEqual([]);
  });

  it("每天固定时间错过了（电脑关着）：第二天打开时补做一次", () => {
    const d = [dest("z", "zip")];
    // 上次同步是 10 月 30 日 9 点，10 月 30 日 23 点没开机；31 日早上 8 点打开
    expect(ids(dueDestinations(d, { now: at(8, 0, 31), lastSync: { z: at(9, 0, 30) }, lastEdit: 0, startup: false }))).toEqual(["z:daily"]);
  });

  it("目的地暂停或关闭了自动同步：不触发", () => {
    const off = { ...dest("a", "backup"), enabled: false };
    const noAuto = dest("b", "backup", { enabled: false });
    expect(dueDestinations([off, noAuto], { now: at(12), lastSync: {}, lastEdit: at(11), startup: true })).toEqual([]);
  });

  it("从没同步过的定时目的地：马上同步一次", () => {
    expect(ids(dueDestinations([dest("b", "backup")], { now: at(12), lastSync: {}, lastEdit: 0, startup: false }))).toEqual(["b:interval"]);
  });

  it("最近一次的每日时间点", () => {
    expect(lastOccurrence("23:00", at(23, 30))).toBe(at(23, 0));
    expect(lastOccurrence("23:00", at(8, 0))).toBe(at(23, 0, 30));
  });
});
