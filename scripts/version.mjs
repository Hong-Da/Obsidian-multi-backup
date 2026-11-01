// pnpm version 时调用：把 package.json 的版本同步到 manifest.json 与 versions.json
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version ?? JSON.parse(readFileSync("package.json", "utf8")).version;
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
console.log(`manifest.json / versions.json → ${version}（minAppVersion ${manifest.minAppVersion}）`);
