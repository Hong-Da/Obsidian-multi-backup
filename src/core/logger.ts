// 日志：按级别过滤、脱敏后写入各输出端。不依赖 obsidian 包。

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  write(level: LogLevel, line: string, time: Date): void;
}

const MASK = "***";
// 常见的凭据写法：Authorization 头、Bearer 令牌、URL 中的 user:pass@、key=value 形式
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*["']?)[^"',\s}]+(\s+[^"',\s}]+)?/gi, `$1${MASK}`],
  [/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${MASK}@`],
  [/((?:password|passwd|secret|token|access_?key|secret_?key|client_?secret)["']?\s*[:=]\s*["']?)[^"'&,\s}]+/gi, `$1${MASK}`],
];

export class Logger {
  private readonly secrets = new Set<string>();

  constructor(
    private readonly sinks: LogSink[],
    public level: LogLevel = "info",
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 登记一个凭据值，之后出现在日志中的地方都会被替换为 *** */
  addSecret(value: string | null | undefined): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    // 先替换长的，避免短值是长值的一部分时只替换一半
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
    for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
    return out;
  }

  debug(msg: string, data?: unknown): void {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: unknown): void {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: unknown): void {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: unknown): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const time = this.now();
    let line = `${time.toISOString()} [${level.toUpperCase()}] ${msg}`;
    if (data !== undefined) line += " " + formatData(data);
    line = this.redact(line);
    for (const sink of this.sinks) sink.write(level, line, time);
  }
}

function formatData(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
