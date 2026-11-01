import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleSink } from "../../src/platform/log-file-sink";

describe("控制台输出", () => {
  afterEach(() => vi.restoreAllMocks());

  it("默认只输出错误和警告", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new ConsoleSink();
    sink.write("info", "i");
    sink.write("debug", "d");
    sink.write("warn", "w");
    sink.write("error", "e");
    expect(debug).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("w");
    expect(error).toHaveBeenCalledWith("e");
  });

  it("打开调试日志后输出其余日志", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    let on = false;
    const sink = new ConsoleSink(() => on);
    sink.write("info", "a");
    on = true;
    sink.write("info", "b");
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("b");
  });
});
