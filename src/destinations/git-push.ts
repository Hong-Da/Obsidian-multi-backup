// 推送一个数据包（git smart HTTP 的 receive-pack），只发本次新写的对象。
// isomorphic-git 的 push 会把新旧两个提交的整棵树各走一遍来挑对象，移动端上很慢；
// 远程 Git 目的地自己知道哪些对象是新的，打好包直接发送。

import { version, type HttpClient } from "isomorphic-git";

export const ZERO_OID = "0".repeat(40);

export interface SendPackArgs {
  http: HttpClient;
  url: string;
  /** Authorization 头的值 */
  auth: string;
  ref: string;
  /** 远程分支现在的提交；新建分支时为全 0 */
  oldOid: string;
  newOid: string;
  packfile: Uint8Array;
}

export type SendPackResult =
  { ok: true } | { ok: false; reason: string } | { ok: false; status: number; reason: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 一行 pkt-line：4 位十六进制长度（含这 4 位）+ 内容 */
export function pktLine(s: string): Uint8Array {
  const body = enc.encode(s);
  return concat([enc.encode((body.byteLength + 4).toString(16).padStart(4, "0")), body]);
}

/** 拆出 pkt-line 的各行（遇到 0000 跳过） */
export function parsePktLines(data: Uint8Array): string[] {
  const out: string[] = [];
  let at = 0;
  while (at + 4 <= data.byteLength) {
    const len = parseInt(dec.decode(data.subarray(at, at + 4)), 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) {
      at += 4;
      continue;
    }
    if (len < 4) break;
    out.push(dec.decode(data.subarray(at + 4, at + len)).replace(/\n$/, ""));
    at += len;
  }
  return out;
}

export async function sendPack(a: SendPackArgs): Promise<SendPackResult> {
  const cmd = pktLine(`${a.oldOid} ${a.newOid} ${a.ref}\0report-status agent=git/isomorphic-git@${version()}\n`);
  const body = concat([cmd, enc.encode("0000"), a.packfile]);
  const res = await a.http.request({
    url: a.url.replace(/\/+$/, "") + "/git-receive-pack",
    method: "POST",
    headers: {
      Authorization: a.auth,
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
      "User-Agent": `git/isomorphic-git@${version()}`,
    },
    // 和 isomorphic-git 自己一样传数组：Node 的客户端据此一次发出并带上 Content-Length
    body: [body] as unknown as AsyncIterableIterator<Uint8Array>,
  });
  const data = await collect(res.body);
  if (res.statusCode !== 200)
    return { ok: false, status: res.statusCode, reason: dec.decode(data).slice(0, 200) || String(res.statusCode) };
  const lines = parsePktLines(data);
  const unpack = lines.find((l) => l.startsWith("unpack "));
  if (unpack && unpack !== "unpack ok") return { ok: false, reason: unpack };
  const line = lines.find((l) => l.startsWith(`ok ${a.ref}`) || l.startsWith(`ng ${a.ref}`));
  if (line?.startsWith("ok ")) return { ok: true };
  return { ok: false, reason: line ? line.slice(4 + a.ref.length).trim() || "rejected" : "no report" };
}

/** 用户名和令牌拼成 Basic 认证 */
export function basicAuth(username: string, password: string): string {
  const bytes = enc.encode(`${username}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "Basic " + btoa(bin);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  for await (const c of body) parts.push(c);
  return concat(parts);
}
