import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "release-assets");
const output = path.join(root, "latest.json");
const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const refName = process.env.GITHUB_REF_NAME;
const tag = process.env.GITHUB_RELEASE_TAG
  ?? (refName === packageJson.version || refName === `v${packageJson.version}`
    ? refName
    : refName === "main" ? packageJson.version : null);
const repository = process.env.GITHUB_REPOSITORY ?? "megoRU/LanPinger";
if (!tag || ![packageJson.version, `v${packageJson.version}`].includes(tag)) {
  throw new Error(`Expected release tag ${packageJson.version}; got ${tag ?? refName ?? "no ref"}.`);
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function oneMatch(files, expression, label) {
  const matches = files.filter((file) => expression.test(path.basename(file)));
  if (matches.length !== 1) throw new Error(`Expected one ${label}, found ${matches.length}: ${matches.map(path.basename).join(", ")}`);
  return matches[0];
}

const files = await listFiles(root);
const specifications = [
  ["windows-x86_64", /-setup\.exe$/i, "Windows NSIS updater"],
  ["linux-x86_64", /\.AppImage$/i, "Linux AppImage updater"],
  ["darwin-aarch64", /\.app\.tar\.gz$/i, "macOS updater archive"],
];
const platforms = {};
for (const [target, expression, label] of specifications) {
  const artifact = oneMatch(files, expression, label);
  const signaturePath = `${artifact}.sig`;
  if (!files.includes(signaturePath)) throw new Error(`Signature missing for ${path.basename(artifact)}.`);
  const signature = (await fs.readFile(signaturePath, "utf8")).trim();
  if (!signature) throw new Error(`Signature is empty for ${path.basename(artifact)}.`);
  const asset = path.basename(artifact);
  platforms[target] = {
    signature,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
}

const manifest = {
  version: packageJson.version,
  notes: process.env.RELEASE_NOTES ?? "",
  pub_date: new Date().toISOString(),
  platforms,
};
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(process.cwd(), output)} for ${Object.keys(platforms).join(", ")}.`);
