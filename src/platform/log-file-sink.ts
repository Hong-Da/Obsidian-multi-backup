import { normalizePath, type DataAdapter } from "obsidian";
import type { LogLevel, LogSink } from "../core/logger";
import { expiredLogFiles, logFileName } from "../core/log-retention";

/** 把日志追加到插件目录 logs/YYYY-MM-DD.log；写入按顺序排队，失败只输出到控制台 */
export class LogFileSink implements LogSink {
  private queue: Promise<void> = Promise.resolve();
  private readonly dir: string;

  constructor(
    private readonly adapter: DataAdapter,
    pluginDir: string,
  ) {
    this.dir = normalizePath(`${pluginDir}/logs`);
  }

  write(_level: LogLevel, line: string, time: Date): void {
    const file = normalizePath(`${this.dir}/${logFileName(time)}`);
    this.queue = this.queue
      .then(async () => {
        if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
        await this.adapter.append(file, line + "\n");
      })
      .catch((e: unknown) => console.error("[multi-backup] write log failed", e));
  }

  async cleanup(today: Date, keepDays: number): Promise<void> {
    if (!(await this.adapter.exists(this.dir))) return;
    const { files } = await this.adapter.list(this.dir);
    const names = files.map((f) => f.slice(f.lastIndexOf("/") + 1));
    for (const name of expiredLogFiles(names, today, keepDays)) {
      await this.adapter.remove(normalizePath(`${this.dir}/${name}`));
    }
  }

  flush(): Promise<void> {
    return this.queue;
  }
}

/** 同时输出到开发者工具控制台：默认只输出错误和警告，打开调试日志后才输出其余日志（社区插件审核要求） */
export class ConsoleSink implements LogSink {
  constructor(private readonly verbose: () => boolean = () => false) {}

  write(level: LogLevel, line: string): void {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else if (this.verbose()) console.debug(line);
  }
}
