/// <reference types="node" />
// 测试用的本地 HTTP Git 服务：用系统 git 自带的 git http-backend（CGI），仓库放在项目 tmp/ 下。
// 令牌校验：Basic 认证的密码必须等于 token；readonlyToken 只能拉取，推送时返回 403。
import { spawn, execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import * as http from "node:http";
import process from "node:process";
import type { AddressInfo } from "node:net";
import { fs, path } from "./node";

export interface GitServer {
  url(repo: string): string;
  /** 新建空的裸仓库（允许推送） */
  createRepo(repo: string): Promise<string>;
  /** 用系统 git 读出某个分支的文件列表（不含内容） */
  lsTree(repo: string, branch: string): string[];
  /** 用系统 git 读出文件内容 */
  show(repo: string, branch: string, file: string): string;
  log(repo: string, branch: string): string[];
  close(): Promise<void>;
}

export async function startGitServer(root: string, o: { token: string; readonlyToken?: string }): Promise<GitServer> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization ?? "";
    const pass = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
    const pushing = u.searchParams.get("service") === "git-receive-pack" || u.pathname.endsWith("/git-receive-pack");
    if (pass !== o.token && pass !== o.readonlyToken) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      res.end();
      return;
    }
    if (pushing && pass === o.readonlyToken) {
      res.writeHead(403);
      res.end();
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(u.pathname),
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "tester",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (c: Buffer) => chunks.push(c));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const sep = out.indexOf("\r\n\r\n");
      const head = out.subarray(0, sep).toString().split("\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else if (k) headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(sep + 4));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const git = (repo: string, args: string[]) => execFileSync("git", ["-C", path.join(root, repo), "-c", "core.quotepath=false", ...args], { encoding: "utf8" });

  return {
    url: (repo) => `http://127.0.0.1:${port}/${repo}`,
    async createRepo(repo) {
      const dir = path.join(root, repo);
      await fs.mkdir(dir, { recursive: true });
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
      git(repo, ["config", "http.receivepack", "true"]);
      return dir;
    },
    lsTree: (repo, branch) => git(repo, ["ls-tree", "-r", "--name-only", branch]).split("\n").filter(Boolean).sort(),
    show: (repo, branch, file) => git(repo, ["show", `${branch}:${file}`]),
    log: (repo, branch) => git(repo, ["log", "--format=%s", branch]).split("\n").filter(Boolean),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
