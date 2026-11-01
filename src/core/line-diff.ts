// 冲突对比用的逐行比较（最长公共子序列）。纯函数。
// 笔记一般不大；两边行数相乘超过上限时不再细算，整份标为不同，避免卡住界面。

export interface DiffLine {
  text: string;
  /** same：两份都有；changed：只在这一份里（另一份没有或改掉了） */
  kind: "same" | "changed";
}

const LIMIT = 4_000_000;

export function diffLines(a: string, b: string): { left: DiffLine[]; right: DiffLine[] } {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  if (x.length * y.length > LIMIT) {
    return { left: x.map((text) => ({ text, kind: "changed" })), right: y.map((text) => ({ text, kind: "changed" })) };
  }
  // dp[i][j]：x[i..] 与 y[j..] 的最长公共子序列长度；存整张表，便于回溯出每一行
  const n = x.length;
  const m = y.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = x[i] === y[j] ? (dp[at(i + 1, j + 1)] as number) + 1 : Math.max(dp[at(i + 1, j)] as number, dp[at(i, j + 1)] as number);
    }
  }
  const left: DiffLine[] = [];
  const right: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      left.push({ text: x[i] as string, kind: "same" });
      right.push({ text: y[j] as string, kind: "same" });
      i++;
      j++;
    } else if ((dp[at(i + 1, j)] as number) >= (dp[at(i, j + 1)] as number)) {
      left.push({ text: x[i++] as string, kind: "changed" });
    } else {
      right.push({ text: y[j++] as string, kind: "changed" });
    }
  }
  while (i < n) left.push({ text: x[i++] as string, kind: "changed" });
  while (j < m) right.push({ text: y[j++] as string, kind: "changed" });
  return { left, right };
}
