// 记录用户最后一次编辑 Vault 的时间（“修改后自动同步”用）。
// 同步进行中的事件、以及同步时插件自己写过的文件在同步结束后 graceMs 内到达的事件，都不算用户编辑。
// 以前按“同步结束后 2 秒内一律不算”处理，会漏掉用户在这 2 秒里的编辑（M6-2 发现）。

export class EditTracker {
  lastEdit = 0;
  private running = false;
  private readonly own = new Map<string, number>();

  constructor(
    private readonly graceMs = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 同步开始：之前记下的插件写入清空 */
  start(): void {
    this.running = true;
    this.own.clear();
  }

  /** 插件自己改动了这个文件 */
  touched(path: string): void {
    this.own.set(path, this.now());
  }

  /** 同步结束：插件写过的文件从现在起 graceMs 内的事件都忽略 */
  end(): void {
    this.running = false;
    const t = this.now();
    for (const k of this.own.keys()) this.own.set(k, t);
  }

  /** Vault 里有文件被修改、新建、删除或改名 */
  edited(path?: string): void {
    if (this.running) return;
    const t = this.now();
    if (path !== undefined) {
      const own = this.own.get(path);
      if (own !== undefined && t - own < this.graceMs) return;
    }
    this.lastEdit = t;
  }
}
