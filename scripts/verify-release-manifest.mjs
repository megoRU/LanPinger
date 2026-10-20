import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "release-assets");
const manifest = JSON.parse(await fs.readFile(path.join(root, "latest.json"), "utf8"));
const expected = ["windows-x86_64", "linux-x86_64", "darwin-aarch64"];
if (!manifest.version || !manifest.pub_date || !manifest.platforms) throw new Error("Manifest is missing required updater fields.");
for (const target of expected) {
  const platform = manifest.platforms[target];
  if (!platform?.url?.startsWith("https://github.com/megoRU/LanPinger/releases/download/") || !platform.signature) {
    throw new Error(`Manifest entry ${target} is missing a release URL or signature.`);
  }
}
if (Object.keys(manifest.platforms).length !== expected.length) throw new Error("Manifest has unexpected platform entries.");
console.log(`Verified Tauri Updater v2 manifest ${manifest.version} with all ${expected.length} platform signatures.`);
