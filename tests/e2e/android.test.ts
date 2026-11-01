// 端到端验收（M6-2）：通过远程调试接口驱动 Android 模拟器上真实的 Obsidian，逐条核对任务文档的验收标准。
//
// 前提：模拟器里的 Obsidian 已打开测试 Vault 并启用最新构建的插件；adb 已把调试端口转发到 127.0.0.1:9222
//   adb forward tcp:9222 localabstract:webview_devtools_remote_<Obsidian 的 pid>
// 运行：MB_TEST_CMD="pnpm test:e2e" bash scripts/test-services.sh（Gitea、WebDAV、S3 在测试机的 Docker 里）
//
// 对测试 Vault 的影响：测试数据只放在 E2E/ 文件夹；开始前保存插件设置，结束后恢复设置、删除 E2E/、测试用的凭据和历史记录。
// 你自己的目的地（GitHub、Gitee 等）在测试期间关闭自动同步，不会被推送测试数据。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import process from "node:process";
import { Buffer } from "node:buffer";
import { builtinRules, ExcludeMatcher } from "../../src/core/exclude";
import { signV4 } from "../../src/core/sigv4";
import { runBackup, type DestinationResult } from "../../src/core/sync";
import { LocalMirror } from "../../src/destinations/local-mirror";
import { WebDavFs } from "../../src/destinations/webdav-fs";
import { nodeFetchHttp } from "../support/node-http";
import {
  fs,
  makeTmp,
  MemoryState,
  NodeVaultFs,
  NodeVaultWriter,
  path,
  readText,
  removePath,
  renamePath,
  writeText,
} from "../support/node";

const env = process.env;
const CDP = env.MB_CDP ?? "http://127.0.0.1:9222";
const GITEA = env.MB_GITEA_URL ?? "";
const DAV = env.MB_WEBDAV_URL ?? "";
const S3 = env.MB_S3_ENDPOINT ?? "";
const enabled = !!(GITEA && DAV && S3);
const RUN = Date.now().toString(36);
const out = (s: string) => process.stdout.write(s + "\n");

// ---------- 远程调试 ----------

let ws: WebSocket | null = null;
let seq = 0;
const waiting = new Map<number, (v: unknown) => void>();

async function connect(): Promise<void> {
  const pages = (await (await globalThis.fetch(`${CDP}/json`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("没有找到 Obsidian 页面");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws?.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number };
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
}

/** 在 Obsidian 页面里执行一段异步代码，返回结果（可 JSON 化的值）。代码里可用 p（插件）、sync、ad（DataAdapter） */
async function page<T = unknown>(code: string): Promise<T> {
  const id = ++seq;
  const expression = `(async () => { const p = app.plugins.plugins["multi-backup"]; const sync = p.sync; const ad = app.vault.adapter; ${LIB} ${code} })()`;
  const done = new Promise<unknown>((r) => waiting.set(id, r));
  ws?.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true, timeout: 1_800_000 },
    }),
  );
  const m = (await done) as {
    result?: { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } };
  };
  if (m.result?.exceptionDetails)
    throw new Error(
      "页面内出错：" + (m.result.exceptionDetails.exception?.description ?? JSON.stringify(m.result.exceptionDetails)),
    );
  return m.result?.result?.value as T;
}

/** 页面里的公用函数 */
const LIB = `
const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hashAll(skip) {
  const out = {};
  for (const f of app.vault.getFiles()) {
    if (skip && f.path.startsWith(skip)) continue;
    out[f.path] = hex(await crypto.subtle.digest("SHA-256", await ad.readBinary(f.path)));
  }
  return out;
}
async function writeFile(path, text) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !(await ad.exists(dir))) await ad.mkdir(dir);
  const f = app.vault.getAbstractFileByPath(path);
  if (f) await app.vault.modify(f, text);
  else await app.vault.create(path, text);
}
async function readFile(path) { return (await ad.exists(path)) ? ad.read(path) : null; }
function last(id) {
  const e = sync.history.find((h) => h.destinations.some((d) => d.id === id));
  const d = e?.destinations.find((d) => d.id === id);
  return d ? { status: d.status, uploaded: d.uploaded, moved: d.moved, deleted: d.deleted, error: d.errorCode ?? null, errorPath: d.errorPath ?? null, trigger: e.trigger, at: e.finishedAt, ms: e.finishedAt - e.startedAt, primary: d.primary ?? null } : null;
}
async function run(id) { await sync.syncOne(id, "settings"); return last(id); }
async function addDest(cfg) { p.settings.destinations = p.settings.destinations.filter((d) => d.id !== cfg.id); p.settings.destinations.push(cfg); await p.saveSettings(); }
async function resetBase() {
  for (const f of list("E2E/")) if (!f.startsWith("E2E/perf/")) await app.vault.delete(app.vault.getAbstractFileByPath(f));
  for (const [f, t] of [["E2E/a.md", "# A1"], ["E2E/b.md", "B1"], ["E2E/c.md", "C1"], ["E2E/子文件夹/中文 笔记.md", "中文内容"]]) await writeFile(f, t);
}
function list(dir) { return app.vault.getFiles().filter((f) => f.path.startsWith(dir)).map((f) => f.path).sort(); }
`;

// ---------- 测试服务 ----------

const davUser = env.MB_WEBDAV_USER ?? "";
const davPass = env.MB_WEBDAV_PASSWORD ?? "";
const giteaUser = env.MB_GITEA_USER ?? "";
const giteaBasic = "Basic " + Buffer.from(`${giteaUser}:${env.MB_GITEA_PASSWORD ?? ""}`).toString("base64");
const S3_BUCKET = "mbtest";
let giteaToken = "";
const repos: Record<string, string> = {};

async function giteaRepo(name: string): Promise<string> {
  const r = await globalThis.fetch(`${GITEA}/api/v1/user/repos`, {
    method: "POST",
    headers: { Authorization: giteaBasic, "Content-Type": "application/json" },
    body: JSON.stringify({ name, private: true }),
  });
  expect(r.status).toBe(201);
  const url = `${GITEA}/${giteaUser}/${name}.git`;
  repos[name] = url;
  return url;
}
async function giteaFile(repo: string, file: string): Promise<string | null> {
  const p = file.split("/").map(encodeURIComponent).join("/");
  for (let i = 0; i < 20; i++) {
    const r = await globalThis.fetch(`${GITEA}/api/v1/repos/${giteaUser}/${repo}/raw/${p}?ref=main`, {
      headers: { Authorization: giteaBasic },
    });
    if (r.status === 200) return r.text();
    await new Promise((res) => setTimeout(res, 300));
  }
  return null;
}
const dav = () => new WebDavFs({ url: DAV, username: davUser, password: davPass, http: nodeFetchHttp });
async function davFile(file: string): Promise<string | null> {
  return dav()
    .readFile(file)
    .then(
      (d) => new TextDecoder().decode(d),
      () => null,
    );
}
async function s3File(key: string): Promise<string | null> {
  const url = `${S3}/${S3_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const h = await signV4(
    { method: "GET", url, headers: {} },
    { accessKeyId: env.MB_S3_KEY ?? "", secretAccessKey: env.MB_S3_SECRET ?? "", region: "us-east-1", service: "s3" },
    new Date(),
  );
  const r = await globalThis.fetch(url, { headers: h });
  return r.status === 200 ? r.text() : null;
}

// ---------- 目的地配置（与插件设置格式相同） ----------

const NO_AUTO = {
  enabled: false,
  interval: { on: false, minutes: 30 },
  afterEdit: { on: false, seconds: 60 },
  onStartup: false,
  daily: { on: false, time: "23:00" },
};
/** 只同步 E2E/：把 Vault 根目录下其余的文件夹和文件都排除（在页面里算） */
let onlyE2E = "";
const base = (id: string, name: string, extra = onlyE2E) => ({
  id,
  name,
  enabled: true,
  path: "",
  extraExcludes: extra,
  uploadConfig: true,
  auto: NO_AUTO,
});
const davCfg = (id: string, folder: string, o: { secret?: string; url?: string; extra?: string } = {}) => ({
  ...base(id, `E2E WebDAV ${id}`, o.extra),
  type: "webdav",
  preset: "other",
  url: o.url ?? DAV,
  username: davUser,
  passwordSecret: o.secret ?? "mb-e2e-dav",
  folder,
  deletePolicy: "trash30",
  keepVersions: 10,
});
const s3Cfg = (id: string, prefix: string) => ({
  ...base(id, `E2E S3 ${id}`),
  type: "s3",
  preset: "minio",
  endpoint: S3,
  region: "us-east-1",
  bucket: S3_BUCKET,
  prefix,
  accessKeyId: env.MB_S3_KEY ?? "",
  secretKeySecret: "mb-e2e-s3",
  pathStyle: true,
  deletePolicy: "trash30",
  keepVersions: 10,
});
const giteaCfg = (id: string, url: string, o: { secret?: string; extra?: string } = {}) => ({
  ...base(id, `E2E Gitea ${id}`, o.extra),
  type: "git-remote",
  provider: "other",
  url,
  branch: "main",
  username: giteaUser,
  tokenSecret: o.secret ?? "mb-e2e-gitea",
  commitMessage: "E2E {date} {time}",
  authorName: "Multi Backup",
  authorEmail: "multi-backup@localhost",
});

interface Last {
  status: string;
  uploaded: number;
  moved: number;
  deleted: number;
  error: string | null;
  errorPath: string | null;
  trigger: string;
  at: number;
  ms: number;
  primary: { downloaded: number; deletedLocal: number; conflicts: unknown[] } | null;
}

const report: { item: string; result: string }[] = [];
const note = (item: string, result: string) => {
  report.push({ item, result });
  out(`[e2e] ${item}：${result}`);
};

let snapshot = "";
let restoresBefore = 0;

describe.skipIf(!enabled)("Android 模拟器端到端验收", () => {
  beforeAll(async () => {
    await connect();
    const info = await page<{ mobile: boolean; version: string; files: number; device: string }>(
      `return { mobile: app.isMobile, version: p.manifest.version, files: app.vault.getFiles().length, device: sync.deviceName() };`,
    );
    out(`[e2e] 模拟器：mobile=${info.mobile}，插件 ${info.version}，Vault ${info.files} 个文件，设备名 ${info.device}`);
    expect(info.mobile).toBe(true);
    // 保存设置（本地也留一份，测试中途崩溃时可手动恢复；只含密钥名，不含凭据）
    snapshot = await page<string>(`return JSON.stringify(p.settings);`);
    await fs.mkdir(path.join("tmp"), { recursive: true });
    await fs.writeFile(path.join("tmp", "e2e-settings-backup.json"), snapshot);
    restoresBefore = await page<number>(`return sync.restores.length;`);
    // 关掉所有目的地的自动同步；准备 E2E/ 文件夹和测试用凭据
    onlyE2E = await page<string>(`
      for (const d of p.settings.destinations) d.auto = { ...d.auto, enabled: false };
      await p.saveSettings();
      if (await ad.exists("E2E")) await ad.rmdir("E2E", true);
      const top = await ad.list("");
      const rules = [...top.folders.filter((f) => f !== "E2E").map((f) => "/" + f + "/"), ...top.files.map((f) => "/" + f)];
      return rules.join("\\n");
    `);
    const tk = await globalThis.fetch(`${GITEA}/api/v1/users/${giteaUser}/tokens`, {
      method: "POST",
      headers: { Authorization: giteaBasic, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `e2e-${RUN}`, scopes: ["write:repository"] }),
    });
    giteaToken = ((await tk.json()) as { sha1: string }).sha1;
    const s3url = `${S3}/${S3_BUCKET}`;
    await globalThis.fetch(s3url, {
      method: "PUT",
      headers: await signV4(
        { method: "PUT", url: s3url, headers: {} },
        {
          accessKeyId: env.MB_S3_KEY ?? "",
          secretAccessKey: env.MB_S3_SECRET ?? "",
          region: "us-east-1",
          service: "s3",
        },
        new Date(),
      ),
    });
    await page(`
      app.secretStorage.setSecret("mb-e2e-dav", ${JSON.stringify(davPass)});
      app.secretStorage.setSecret("mb-e2e-s3", ${JSON.stringify(env.MB_S3_SECRET ?? "")});
      app.secretStorage.setSecret("mb-e2e-gitea", ${JSON.stringify(giteaToken)});
      app.secretStorage.setSecret("mb-e2e-bad", "wrong-password-e2e");
      for (const [f, t] of [["E2E/a.md", "# A1"], ["E2E/b.md", "B1"], ["E2E/c.md", "C1"], ["E2E/子文件夹/中文 笔记.md", "中文内容"]]) await writeFile(f, t);
    `);
  });

  afterAll(async () => {
    if (!ws) return;
    try {
      const ids = await page<string[]>(`
        // 先删测试文件、清理记录，最后才恢复设置（恢复后你的目的地会重新自动同步，那时测试文件必须已经不在了）
        while (sync.running) await new Promise((r) => setTimeout(r, 500));
        for (const d of p.settings.destinations) d.auto = { ...d.auto, enabled: false };
        if (await ad.exists("E2E")) await ad.rmdir("E2E", true);
        const before = JSON.parse(${JSON.stringify(snapshot)});
        const e2e = p.settings.destinations.filter((d) => d.id.startsWith("e2e-")).map((d) => d.id);
        for (const n of ["mb-e2e-dav", "mb-e2e-s3", "mb-e2e-gitea", "mb-e2e-bad"]) app.secretStorage.setSecret(n, "");
        sync.history = sync.history.filter((h) => !h.destinations.some((d) => d.id.startsWith("e2e-")));
        await sync.ctx.state.saveHistory(sync.history);
        sync.conflicts = sync.conflicts.filter((c) => !c.path.startsWith("E2E/"));
        await sync.ctx.state.saveConflicts(sync.conflicts);
        sync.restores = sync.restores.slice(sync.restores.length - ${restoresBefore});
        await sync.ctx.state.saveRestores(sync.restores);
        for (const id of e2e) await sync.forgetDestination(id).catch(() => {});
        p.settings = Object.assign(p.settings, before);
        await p.saveSettings();
        sync.changed?.();
        return e2e;
      `);
      out(`[e2e] 已恢复设置，清理测试目的地 ${ids.join("、")}、E2E/ 文件夹与测试凭据`);
    } finally {
      ws.close();
      await fs.writeFile(path.join("tmp", "e2e-report.json"), JSON.stringify(report, null, 2));
    }
  });

  // 验收标准 1：每种目的地首次备份、增量备份、恢复（手机上的非本地目的地）
  for (const kind of ["WebDAV", "S3", "Gitea"] as const) {
    it(`标准 1 · ${kind}：首次、增量（改、改名、删）、恢复与撤销`, async () => {
      const id = `e2e-${kind.toLowerCase()}`;
      const root = `/e2e-${RUN}-${kind.toLowerCase()}`;
      const repo = `e2e-${RUN}`;
      const cfg =
        kind === "WebDAV" ? davCfg(id, root) : kind === "S3" ? s3Cfg(id, root) : giteaCfg(id, await giteaRepo(repo));
      const remote = (f: string) =>
        kind === "WebDAV"
          ? davFile(`${root}/${f}`)
          : kind === "S3"
            ? s3File(`${root.slice(1)}/${f}`)
            : giteaFile(repo, f);
      await page(`await resetBase(); await addDest(${JSON.stringify(cfg)});`);

      const first = await page<Last>(`return run(${JSON.stringify(id)});`);
      expect(first, JSON.stringify(first)).toMatchObject({ status: "ok", uploaded: 4 });
      expect(await remote("E2E/子文件夹/中文 笔记.md")).toBe("中文内容");

      const inc = await page<Last>(`
        await writeFile("E2E/a.md", "# A2 ${kind}");
        await app.fileManager.renameFile(app.vault.getAbstractFileByPath("E2E/b.md"), "E2E/b2.md");
        await app.vault.delete(app.vault.getAbstractFileByPath("E2E/c.md"));
        return run(${JSON.stringify(id)});
      `);
      expect(inc).toMatchObject({ status: "ok", uploaded: 1, moved: 1, deleted: 1 });
      expect(await remote("E2E/a.md")).toBe(`# A2 ${kind}`);
      expect(await remote("E2E/b2.md")).toBe("B1");
      expect(await remote("E2E/c.md")).toBeNull();

      // 恢复：把本机 a.md 改坏，从最新的备份恢复这个文件，再撤销
      const rs = await page<{ planned: string[]; after: string | null; undone: string | null }>(`
        await writeFile("E2E/a.md", "坏掉的内容");
        const cfg = p.settings.destinations.find((d) => d.id === ${JSON.stringify(id)});
        const src = await sync.restoreSource(cfg);
        const pts = await src.points(5);
        const plan = await sync.previewRestore(cfg, src, pts[0].id, ["E2E/a.md"], false);
        const rec = await sync.restore(cfg, src, pts[0].id, pts[0].title ?? "", plan);
        const after = await readFile("E2E/a.md");
        await sync.undoRestore(rec);
        const undone = await readFile("E2E/a.md");
        return { planned: plan.overwrite, after, undone };
      `);
      expect(rs).toEqual({ planned: ["E2E/a.md"], after: `# A2 ${kind}`, undone: "坏掉的内容" });
      note(
        `标准 1 · ${kind}`,
        `首次 ${first.ms} ms（4 个文件），增量 ${inc.ms} ms（改 1、改名 1、删 1），恢复与撤销通过`,
      );
    });
  }

  // 验收标准 3：同步失败（令牌失效、断网）不删除、不改动本地文件；作为主同步端失败时也一样
  it("标准 3 · 失败时本地文件不变：密码错误、令牌失效、连不上，作为备份端与主同步端", async () => {
    const before = await page<Record<string, string>>(`return hashAll();`);
    const cases = [
      davCfg("e2e-bad-dav", `/e2e-${RUN}-bad`, { secret: "mb-e2e-bad" }),
      davCfg("e2e-down", `/e2e-${RUN}-down`, { url: DAV.replace(/:\d+\//, ":1/") }),
      giteaCfg("e2e-bad-git", await giteaRepo(`e2e-${RUN}-bad`), { secret: "mb-e2e-bad" }),
    ];
    const codes: Record<string, string | null> = {};
    for (const c of cases) {
      const r = await page<Last>(`await addDest(${JSON.stringify(c)}); return run(${JSON.stringify(c.id)});`);
      expect(r.status).toBe("failed");
      codes[c.id] = r.error;
    }
    // 主同步端：远程连不上、密码错误
    const prim: Record<string, string | null> = {};
    for (const id of ["e2e-down", "e2e-bad-dav"]) {
      const r = await page<Last>(
        `p.settings.primaryId = ${JSON.stringify(id)}; await p.saveSettings(); const r = await run(${JSON.stringify(id)}); p.settings.primaryId = JSON.parse(${JSON.stringify(snapshot)}).primaryId; await p.saveSettings(); return r;`,
      );
      expect(r.status).toBe("failed");
      prim[id] = r.error;
    }
    const after = await page<Record<string, string>>(`return hashAll();`);
    expect(after).toEqual(before);
    expect(codes["e2e-bad-dav"]).toBe("auth-failed");
    expect(codes["e2e-down"]).toBe("network");
    expect(codes["e2e-bad-git"]).toBe("auth-failed");
    note(
      "标准 3",
      `备份端错误 ${JSON.stringify(codes)}，主同步端错误 ${JSON.stringify(prim)}；${Object.keys(before).length} 个本地文件哈希前后一致`,
    );
  });

  // 验收标准 2：主同步端双向同步（模拟器 = 设备 A，本机 Node = 设备 B）
  it("标准 2 · 主同步端双向同步：两台设备交替改、增、删、改名，最终一致；冲突两份都保留并登记", async () => {
    const root = `/e2e-${RUN}-primary`;
    const id = "e2e-primary";
    await page(
      `await resetBase(); await addDest(${JSON.stringify(davCfg(id, root))}); p.settings.primaryId = ${JSON.stringify(id)}; await p.saveSettings();`,
    );
    const tmp = await makeTmp();
    const vb = path.join(tmp.dir, "vault-b");
    await fs.mkdir(vb, { recursive: true });
    const stateB = new MemoryState();
    const syncB = async () =>
      (
        await runBackup(
          {
            vault: new NodeVaultFs(vb),
            state: stateB,
            matcher: new ExcludeMatcher(
              builtinRules({
                configDir: ".obsidian",
                pluginDir: ".obsidian/plugins/multi-backup",
                includeConfigDir: true,
              }),
            ),
            maxFileSize: 1 << 30,
          },
          [],
          {
            id: "b",
            store: new LocalMirror(dav(), {
              root,
              deletePolicy: "trash30",
              keepVersions: 10,
              createRoot: true,
            }).asPrimary(),
            extraExcludes: [],
            writer: new NodeVaultWriter(vb),
            device: "e2e-desktop",
          },
        )
      ).destinations[0] as DestinationResult;
    const fileB = (f: string) => path.join(vb, ...f.split("/"));
    const listB = async () =>
      (await import("../support/node"))
        .listTree(path.join(vb, "E2E"))
        .then((l) => l.map((f) => "E2E/" + f).filter((f) => !f.includes(".trash")));
    try {
      // A 首次上传；B 首次下载
      expect(await page<Last>(`return run(${JSON.stringify(id)});`)).toMatchObject({ status: "ok" });
      expect((await syncB()).status).toBe("ok");
      expect(await readText(fileB("E2E/子文件夹/中文 笔记.md"))).toBe("中文内容");
      // A：改 a、新增 d；B 拿到
      await page(
        `await writeFile("E2E/a.md", "# A 在手机上改"); await writeFile("E2E/d.md", "D 新增"); return run(${JSON.stringify(id)});`,
      );
      expect((await syncB()).status).toBe("ok");
      expect(await readText(fileB("E2E/a.md"))).toBe("# A 在手机上改");
      expect(await readText(fileB("E2E/d.md"))).toBe("D 新增");
      // B：删 d、改名 b、改 c；A 拿到
      await removePath(fileB("E2E/d.md"));
      await renamePath(fileB("E2E/b.md"), fileB("E2E/b 改名.md"));
      await writeText(fileB("E2E/c.md"), "C 在电脑上改", Date.now() + 2000);
      expect((await syncB()).status).toBe("ok");
      const a1 = await page<{ r: Last; files: string[]; c: string | null }>(
        `const r = await run(${JSON.stringify(id)}); return { r, files: list("E2E/"), c: await readFile("E2E/c.md") };`,
      );
      expect(a1.r.status).toBe("ok");
      expect(a1.c).toBe("C 在电脑上改");
      expect(a1.files).toEqual((await listB()).sort());
      // 冲突：B 先改 q 并同步；A 也改 q 再同步 → A 上两份都在，冲突列表有这一项
      await page(`await writeFile("E2E/q.md", "Q 原始"); return run(${JSON.stringify(id)});`);
      expect((await syncB()).status).toBe("ok");
      await writeText(fileB("E2E/q.md"), "Q 电脑版", Date.now() + 4000);
      expect((await syncB()).status).toBe("ok");
      const cf = await page<{ r: Last; q: string | null; copies: string[]; listed: unknown[] }>(`
        await writeFile("E2E/q.md", "Q 手机版");
        const r = await run(${JSON.stringify(id)});
        const copies = list("E2E/").filter((f) => f.startsWith("E2E/q") && f !== "E2E/q.md");
        const texts = []; for (const f of copies) texts.push(await readFile(f));
        return { r, q: await readFile("E2E/q.md"), copies: texts, listed: sync.conflicts.filter((c) => c.path === "E2E/q.md") };
      `);
      expect(cf.r.status).toBe("ok");
      expect([cf.q, ...cf.copies].sort()).toEqual(["Q 手机版", "Q 电脑版"].sort());
      expect(cf.listed.length).toBe(1);
      // B 再同步：也拿到冲突副本，两边文件列表一致
      expect((await syncB()).status).toBe("ok");
      const filesA = await page<string[]>(`return list("E2E/");`);
      expect(filesA).toEqual((await listB()).sort());
      note(
        "标准 2",
        `两台设备交替修改、新增、删除、改名后一致（${filesA.length} 个文件）；冲突保留两份，冲突列表 ${cf.listed.length} 项`,
      );
    } finally {
      await page(`p.settings.primaryId = JSON.parse(${JSON.stringify(snapshot)}).primaryId; await p.saveSettings();`);
      await tmp.cleanup();
    }
  });

  // 验收标准 7：凭据不出现在日志、插件数据、备份内容和上传的配置里
  it("标准 7 · 凭据不以明文出现在日志、插件数据、备份内容和上传的配置中", async () => {
    const r = await page<{ secrets: number; files: number; hits: string[]; configs: number; configHits: number }>(`
      const names = new Set();
      for (const d of p.settings.destinations) for (const k of ["tokenSecret", "passwordSecret", "secretKeySecret"]) if (d[k]) names.add(d[k]);
      for (const d of p.settings.destinations) if (d.type === "cloud") names.add("mb-oauth-" + d.id);
      const values = [...names].map((n) => app.secretStorage.getSecret(n)).filter((v) => v && v.length >= 6);
      const hits = [];
      let files = 0;
      const walk = async (dir) => {
        const l = await ad.list(dir);
        for (const f of l.files) {
          files++;
          const t = await ad.read(f).catch(() => "");
          if (values.some((v) => t.includes(v))) hits.push(f);
        }
        // git 对象是压缩过的二进制，跳过；仓库的 config（远程地址）照样检查
        for (const d of l.folders) if (!d.endsWith("/objects")) await walk(d);
      };
      await walk(p.manifest.dir);
      const cfg = p.settings.destinations.find((d) => d.id === "e2e-webdav");
      const configs = await sync.readConfigs(cfg);
      const configHits = configs.filter((c) => values.some((v) => JSON.stringify(c).includes(v))).length;
      return { secrets: values.length, files, hits, configs: configs.length, configHits };
    `);
    expect(r.secrets).toBeGreaterThanOrEqual(3);
    expect(r.hits).toEqual([]);
    expect(r.configs).toBeGreaterThanOrEqual(1);
    expect(r.configHits).toBe(0);
    // 备份内容：WebDAV 上的配置文件与备份文件里也没有测试凭据
    const root = `/e2e-${RUN}-webdav`;
    const remoteFiles = await dav().list(`${root}/.multi-backup/config`);
    for (const f of remoteFiles) {
      const t = (await davFile(`${root}/.multi-backup/config/${f.name}`)) ?? "";
      for (const v of [davPass, giteaToken, env.MB_S3_SECRET ?? ""]) expect(t.includes(v)).toBe(false);
    }
    note(
      "标准 7",
      `检查 ${r.secrets} 个凭据：插件目录 ${r.files} 个文件（含日志、data.json、历史、状态）与 ${r.configs} 份上传的配置中都没有明文`,
    );
  });

  // 验收标准 8：新设备从目的地导入配置后，只需填凭据
  it("标准 8 · 从目的地导入配置：目的地设置齐全，只缺凭据", async () => {
    const r = await page<{ dests: string[]; needSecret: string[]; same: boolean }>(`
      const cfg = p.settings.destinations.find((d) => d.id === "e2e-webdav");
      await run("e2e-webdav"); // 先把当前设置上传一次
      const mine = (await sync.readConfigs(cfg)).find((c) => c.device === sync.deviceName());
      const desc = sync.describeImport(mine);
      const before = JSON.stringify(p.settings.destinations.map(({ id, type, name }) => ({ id, type, name })));
      await sync.importConfig(mine);
      const after = JSON.stringify(p.settings.destinations.map(({ id, type, name }) => ({ id, type, name })));
      return { dests: desc.dests, needSecret: desc.needSecret, same: before === after };
    `);
    expect(r.same).toBe(true);
    expect(r.dests.length).toBeGreaterThan(3);
    note(
      "标准 8",
      `导入后 ${r.dests.length} 个目的地与原来一致；需要填写凭据的：${r.needSecret.join("、") || "（本机已有凭据）"}`,
    );
  });

  // 验收标准 5：自动同步的四种触发方式；同步时编辑不卡顿
  it("标准 5 · 自动同步：启动时、修改后、定时、每天定点都会触发", async () => {
    const id = "e2e-webdav";
    // 时间都用模拟器的时钟和时区（与电脑可能不同）
    const now = () => page<number>(`return Date.now();`);
    const at = (m: number) =>
      page<string>(
        `const d = new Date(Date.now() + ${m} * 60_000); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");`,
      );
    const set = (auto: object) =>
      page(
        `const d = p.settings.destinations.find((d) => d.id === ${JSON.stringify(id)}); d.auto = ${JSON.stringify(auto)}; await p.saveSettings();`,
      );
    const lastAt = () => page<Last>(`return last(${JSON.stringify(id)});`);
    const waitAuto = async (since: number, sec: number) => {
      for (let i = 0; i < sec; i++) {
        const l = await lastAt();
        if (l && l.at > since && l.trigger === "auto") return l;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return null;
    };
    const res: Record<string, boolean> = {};
    // 修改后 3 秒
    await set({ ...NO_AUTO, enabled: true, afterEdit: { on: true, seconds: 3 } });
    let t0 = await now();
    await page(`await writeFile("E2E/auto.md", "修改后自动同步 " + Date.now());`);
    res.afterEdit = !!(await waitAuto(t0, 40));
    if (!res.afterEdit)
      out(
        "[e2e] 修改后没有触发：" +
          JSON.stringify(
            await page(
              `const d = p.settings.destinations.find((d) => d.id === "e2e-webdav"); return { t0: ${t0}, now: Date.now(), lastEdit: sync.edits.lastEdit, running: !!sync.running, auto: d.auto, enabled: d.enabled, last: last("e2e-webdav"), top: sync.history.slice(0, 3).map((h) => [h.trigger, h.finishedAt, h.destinations.map((x) => x.id + ":" + x.status).join(",")]) };`,
            ),
          ),
      );
    // 启动时：重新加载插件
    await set({ ...NO_AUTO, enabled: true, onStartup: true });
    t0 = await now();
    await page(`await app.plugins.disablePlugin("multi-backup"); await app.plugins.enablePlugin("multi-backup");`);
    res.onStartup = !!(await waitAuto(t0, 60));
    // 定时（每 1 分钟）与每天定点（下一分钟）
    await set({ ...NO_AUTO, enabled: true, interval: { on: true, minutes: 1 } });
    t0 = await now();
    res.interval = !!(await waitAuto(t0, 100));
    await set({ ...NO_AUTO, enabled: true, daily: { on: true, time: await at(1) } });
    t0 = await now();
    res.daily = !!(await waitAuto(t0, 150));
    await set(NO_AUTO);
    expect(res).toEqual({ afterEdit: true, onStartup: true, interval: true, daily: true });
    note("标准 5", "修改后、启动时、每 1 分钟、每天定点四种触发都自动同步了");
  });

  it("标准 5 · 同步时编辑不卡顿：同步过程中主线程最长被占用多久", async () => {
    const r = await page<{ ms: number; lag: number; edits: number }>(`
      await writeFile("E2E/lag.md", "x");
      let lag = 0, tick = performance.now(), edits = 0;
      const probe = setInterval(() => { const n = performance.now(); lag = Math.max(lag, n - tick - 10); tick = n; }, 10);
      const typing = setInterval(() => { edits++; void writeFile("E2E/typing.md", "边同步边写 " + edits); }, 200);
      const t = performance.now();
      await sync.syncOne("e2e-gitea", "settings");
      clearInterval(probe); clearInterval(typing);
      return { ms: Math.round(performance.now() - t), lag: Math.round(lag), edits };
    `);
    expect(r.lag).toBeLessThan(200);
    note("标准 5", `同步 ${r.ms} ms 期间编辑 ${r.edits} 次，主线程最长占用 ${r.lag} ms`);
  });

  // 验收标准 4：5000 篇笔记的 Vault，只改 1 个文件时增量同步 10 秒内（手机）
  it("标准 4 · 手机上约 5000 篇笔记：首次能完成，改 1 个文件 10 秒内（Gitea、WebDAV）", async () => {
    const made = await page<{ total: number; ms: number }>(`
      const t = performance.now();
      if (!(await ad.exists("E2E/perf"))) await ad.mkdir("E2E/perf");
      const have = app.vault.getFiles().length;
      const need = Math.max(0, 5000 - have);
      for (let i = 0; i < need; i++) {
        const dir = "E2E/perf/F" + (i % 50);
        if (i < 50 && !(await ad.exists(dir))) await ad.mkdir(dir);
        await ad.write(dir + "/笔记 " + i + ".md", "# 笔记 " + i + "\\n\\n" + "性能测试内容。".repeat(40 + (i % 80)));
      }
      return { total: have + need, ms: Math.round(performance.now() - t) };
    `);
    out(`[e2e] 生成测试笔记：共 ${made.total} 个文件（${made.ms} ms）`);
    const rows: string[] = [];
    for (const kind of ["Gitea", "WebDAV"] as const) {
      const id = `e2e-perf-${kind.toLowerCase()}`;
      const cfg =
        kind === "Gitea"
          ? giteaCfg(id, await giteaRepo(`e2e-${RUN}-perf`), { extra: "" })
          : davCfg(id, `/e2e-${RUN}-perf`, { extra: "" });
      await page(`await addDest(${JSON.stringify(cfg)});`);
      const first = await page<Last>(`return run(${JSON.stringify(id)});`);
      expect(first.status).toBe("ok");
      const same = await page<Last>(`return run(${JSON.stringify(id)});`);
      const one = await page<Last & { wall: number }>(`
        await ad.write("E2E/perf/F3/笔记 3.md", "改了 " + Date.now());
        await new Promise((r) => setTimeout(r, 1500));
        const t = performance.now();
        const r = await run(${JSON.stringify(id)});
        return { ...r, wall: Math.round(performance.now() - t) };
      `);
      expect(one).toMatchObject({ status: "ok", uploaded: 1 });
      expect(one.wall).toBeLessThan(10_000);
      rows.push(
        `${kind} 首次 ${(first.ms / 1000).toFixed(1)} 秒（${first.uploaded} 个），无变化 ${(same.ms / 1000).toFixed(1)} 秒，改 1 个 ${(one.wall / 1000).toFixed(1)} 秒`,
      );
    }
    note("标准 4", `${made.total} 个文件：${rows.join("；")}`);
  });
});
