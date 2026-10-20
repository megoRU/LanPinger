# Building and releasing LanPinger

## Updater key setup

Tauri Updater 2 verifies update artifacts with minisign signatures. This app also enables `requireSignedVersion`, which requires the signed artifact's trusted version comment to match the version in `latest.json`; the manifest URL and version alone are not treated as signed. Generate a key pair on a trusted workstation:

```sh
npx tauri signer generate -w ~/.tauri/lanpinger.key
```

Copy the generated public key contents into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Store the private key contents only in GitHub Actions Secrets. Do not commit the private key or add it to an artifact.

Add these repository secrets in **Settings → Secrets and variables → Actions**:

| Secret                               | Value                                                       |
|--------------------------------------|-------------------------------------------------------------|
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of the private key file created by the signer.     |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key password, or an empty value for an unencrypted key. |

The public key is application configuration, not a secret. No repository variables are currently required. If this repository changes owner or name, update the updater endpoint and matching validation in `src-tauri/tauri.conf.json`, `scripts/validate-updater-config.mjs`, and `scripts/verify-release-manifest.mjs`.

The repository workflow requests `contents: read` for builds and `contents: write` only for the release job. It uses the built-in `GITHUB_TOKEN`; no personal access token is needed.

## Stable release

1. Update the version in `package.json` (the Tauri configuration reads it directly) and `src-tauri/Cargo.toml`.
2. Run the development checks in the README and commit the version change.
3. Create and push a matching tag, for example `v0.2.0` for version `0.2.0`.
4. The build workflow runs quality checks and builds Windows x64, Linux x64, and macOS ARM64 in separate jobs. The release stage runs only after all three finish successfully.
5. The release stage finds and validates all three signatures, creates Tauri Updater 2 `latest.json`, attaches the installer/update artifacts to a draft release, then publishes it. Until publication, clients cannot see the draft manifest or its assets.

Stable assets include an NSIS `.exe` on Windows, `.AppImage` plus `.deb` and `.rpm` on Linux, and a `.dmg` plus `.app.tar.gz` on macOS. `latest.json` references only the updater-supported `.exe`, `.AppImage`, and `.app.tar.gz` files and contains each matching `.sig` file's contents.

## Preview releases

Use a matching SemVer prerelease such as `0.3.0-beta.1` and tag it `v0.3.0-beta.1`. The workflow publishes it as a GitHub prerelease, not the latest stable release. LanPinger's configured endpoint deliberately follows GitHub's stable `releases/latest` channel, so installed stable builds never receive a preview. Preview packages are available for manual installation; they do not receive automatic preview-to-preview updates.

## Tauri Updater 2 format

The generated manifest has this shape, with signatures and links read from the actual build output:

```json
{
  "version": "0.2.0",
  "notes": "",
  "pub_date": "2026-10-20T00:00:00.000Z",
  "platforms": {
    "windows-x86_64": { "signature": "...", "url": "https://github.com/megoRU/LanPinger/releases/download/v0.2.0/...exe" },
    "linux-x86_64": { "signature": "...", "url": "https://github.com/megoRU/LanPinger/releases/download/v0.2.0/...AppImage" },
    "darwin-aarch64": { "signature": "...", "url": "https://github.com/megoRU/LanPinger/releases/download/v0.2.0/...app.tar.gz" }
  }
}
```

Tauri Updater 2's static manifest requires a SemVer `version` and, for each target, an artifact `url` and the signature contents. `.deb`, `.rpm`, and `.dmg` are not updater entries. The build script checks every asset and signature before creating the release; the verification script checks the resulting target set before upload.

## Workflows and required checks

- `test.yml` checks Rust formatting, Clippy, Rust unit tests, TypeScript, ESLint, and the production frontend build on pushes, pull requests, and manual runs.
- `build-tauri.yml` repeats required quality checks before platform packages, publishes CI packages for `main`, and creates a signed release for `v*` tags.
- GitHub-hosted runner targets: `windows-latest` x64, `ubuntu-24.04` x64, and `macos-15` ARM64.
- Node is pinned to major version 22 and Rust uses stable.

## Troubleshooting

- **Release stops at updater validation:** the public key is still a placeholder or one of the two Actions secrets is missing.
- **Signature validation fails in the app:** confirm the public key corresponds to the private key in `TAURI_SIGNING_PRIVATE_KEY`; never work around this by disabling signature verification.
- **A platform is missing from `latest.json`:** the release job requires exactly one Windows NSIS updater, one Linux AppImage updater, and one macOS `.app.tar.gz`, each with a non-empty neighboring `.sig` file. The draft will not be published if any check fails.
- **AppImage updates but `.deb` / `.rpm` installations do not:** this is expected. Those package formats are distributed as installers but are not the configured Linux updater format.
- **Preview versions are not offered by automatic update:** this is the intentional stable-channel policy. Download a preview from its prerelease page manually.
