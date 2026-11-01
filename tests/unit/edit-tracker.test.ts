import { describe, expect, it } from "vitest";
import { EditTracker } from "../../src/core/edit-tracker";

describe("记录用户编辑（修改后自动同步）", () => {
  it("同步进行中的事件不算；插件写过的文件在同步结束后 5 秒内的事件不算", () => {
    let t = 1000;
    const e = new EditTracker(5000, () => t);
    e.start();
    e.touched("a.md");
    e.edited("a.md");
    expect(e.lastEdit).toBe(0);
    t = 2000;
    e.end();
    t = 3000;
    e.edited("a.md");
    expect(e.lastEdit).toBe(0);
    t = 8000;
    e.edited("a.md");
    expect(e.lastEdit).toBe(8000);
  });

  it("同步刚结束时用户改了别的文件：照样记下（以前 2 秒内会漏掉）", () => {
    let t = 1000;
    const e = new EditTracker(5000, () => t);
    e.start();
    e.touched("downloaded.md");
    t = 1500;
    e.end();
    t = 1600;
    e.edited("my-note.md");
    expect(e.lastEdit).toBe(1600);
  });

  it("下一次同步开始时清掉上次记下的插件写入", () => {
    let t = 1000;
    const e = new EditTracker(5000, () => t);
    e.start();
    e.touched("a.md");
    e.end();
    e.start();
    e.end();
    t = 1100;
    e.edited("a.md");
    expect(e.lastEdit).toBe(1100);
  });
});
