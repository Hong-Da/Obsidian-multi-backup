// SHA-256（WebCrypto，Obsidian 桌面、移动端与 Node 都可用），输出小写十六进制

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
