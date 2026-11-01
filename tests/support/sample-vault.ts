// 验收测试用的样例 Vault：可复现的笔记与附件（同一个种子每次生成的内容相同）
import { fs, path, writeText } from "./node";

const WORDS = ["备份", "同步", "笔记", "插件", "Obsidian", "目的地", "镜像", "快照", "冲突", "恢复", "加密", "WebDAV", "GitHub", "设计", "测试", "里程碑", "需求", "增量", "哈希", "清单"];
const FOLDERS = ["Daily/2026/10", "Daily/2026/09", "Projects/Multi Backup", "Projects/读书会", "Reading/技术", "Reading/文学", "Inbox", "Archive/旧项目", "Notes/深/层/文件夹"];

export class SampleVault {
  private seed = 20261031;

  private rnd(): number {
    return (this.seed = (this.seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  }

  private pick<T>(a: T[]): T {
    return a[Math.floor(this.rnd() * a.length)] as T;
  }

  note(i: number): string {
    const paras = 1 + Math.floor(this.rnd() * 40);
    const lines = [`# 笔记 ${i}`, "", `tags: #${this.pick(WORDS)} #${this.pick(WORDS)}`, ""];
    for (let p = 0; p < paras; p++) lines.push(Array.from({ length: 10 + Math.floor(this.rnd() * 60) }, () => this.pick(WORDS)).join(" "), "");
    if (this.rnd() < 0.3) lines.push(`[[笔记 ${Math.floor(this.rnd() * 1000)}]]`);
    return lines.join("\n");
  }

  /** 在 dir 下生成笔记与附件，返回总字节数 */
  async generate(dir: string, notes: number, attachments: number): Promise<number> {
    let bytes = 0;
    for (let i = 1; i <= notes; i++) {
      const text = this.note(i);
      bytes += new TextEncoder().encode(text).byteLength;
      await writeText(path.join(dir, ...this.pick(FOLDERS).split("/"), `笔记 ${i}.md`), text);
    }
    for (let i = 1; i <= attachments; i++) {
      const size = 100 * 1024 + Math.floor(this.rnd() * 1.9 * 1024 * 1024);
      const data = new Uint8Array(size);
      for (let k = 0; k < size; k += 4096) data[k] = Math.floor(this.rnd() * 256);
      bytes += size;
      const p = path.join(dir, "Attachments", `附件-${i}.${this.pick(["png", "jpg", "pdf"])}`);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, data);
    }
    return bytes;
  }
}
