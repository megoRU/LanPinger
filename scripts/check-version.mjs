import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tauri = JSON.parse(fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargo = fs.readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const tauriVersionPath = new URL(tauri.version, new URL("../src-tauri/", import.meta.url));
const tauriVersion = tauri.version.endsWith(".json")
  ? JSON.parse(fs.readFileSync(tauriVersionPath, "utf8")).version
  : tauri.version;
const versions = { package: packageJson.version, tauri: tauriVersion, cargo: cargoVersion };
if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).some((value) => !value)) {
  console.error("Application version mismatch:", versions);
  process.exit(1);
}

const ref = process.env.GITHUB_REF_NAME;
const releaseVersion = ref?.startsWith("v") ? ref.slice(1) : ref;
if (ref && ref !== "main" && /^\d+\.\d+\.\d+([+-][0-9A-Za-z.-]+)?$/.test(releaseVersion) && releaseVersion !== packageJson.version) {
  console.error(`Release tag ${ref} must match the app version ${packageJson.version}.`);
  process.exit(1);
}
console.log(`LanPinger version ${packageJson.version} is consistent.`);
