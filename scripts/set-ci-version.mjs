import fs from "node:fs";

const root = new URL("../", import.meta.url);
const packagePath = new URL("package.json", root);
const lockPath = new URL("package-lock.json", root);
const cargoPath = new URL("src-tauri/Cargo.toml", root);
const cargoLockPath = new URL("src-tauri/Cargo.lock", root);

const runNumber = Number(process.env.GITHUB_RUN_NUMBER);
if (!Number.isSafeInteger(runNumber) || runNumber < 1) {
  throw new Error("GITHUB_RUN_NUMBER must be a positive integer.");
}

const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);
if (!match) throw new Error(`Expected a stable base version, got ${packageJson.version}.`);
const version = `${match[1]}.${match[2]}.${Number(match[3]) + runNumber}`;

packageJson.version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
packageLock.version = version;
packageLock.packages[""].version = version;
fs.writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);

const cargo = fs.readFileSync(cargoPath, "utf8");
const updatedCargo = cargo.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m, `$1${version}$2`);
if (updatedCargo === cargo) throw new Error("Could not update the package version in Cargo.toml.");
fs.writeFileSync(cargoPath, updatedCargo);

const cargoLock = fs.readFileSync(cargoLockPath, "utf8");
let foundCargoPackage = false;
const updatedCargoLock = cargoLock.split(/(?=^\[\[package\]\]$)/m).map((block) => {
  if (!new RegExp(`^name\\s*=\\s*"${packageJson.name}"$`, "m").test(block)) return block;
  foundCargoPackage = true;
  return block.replace(/(^version\s*=\s*")[^"]+("\s*$)/m, `$1${version}$2`);
}).join("");
if (!foundCargoPackage || updatedCargoLock === cargoLock) {
  throw new Error("Could not update the LanPinger package entry in Cargo.lock.");
}
fs.writeFileSync(cargoLockPath, updatedCargoLock);

if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`CI release version: ${version}`);
