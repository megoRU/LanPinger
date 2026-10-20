# LanPinger

LanPinger is a small desktop utility for watching an IP route over time. Rust performs DNS resolution, ICMP Echo probing with increasing TTL / hop limit, reverse DNS lookups, cancellation, and statistics. React renders the results in a Tauri 2 window; no Node server is bundled with release builds.

The app uses a fixed-size window up to 1280 × 800 logical pixels. It automatically reduces the initial size to fit the active monitor's work area and adjusts when moved between displays with different scale factors. Interface dimensions use logical CSS pixels, so text and controls remain sharp on HiDPI monitors. At startup, the native window stays hidden until the interface has rendered, then appears with its saved or centered position. The app remembers its position and moves it back onto a connected display if the saved position is no longer visible. It supports dark and light themes, CSV and text exports, and signed update installation through Tauri Updater 2.

## Route measurements

- Enter an IPv4/IPv6 address or domain name (including internationalized names) and start monitoring.
- Each sweep sends one ICMP Echo probe at each hop, up to 24 hops, with a 650 ms response timeout per hop. The default pause between completed sweeps is one second; a slow or incomplete trace can take longer than that interval.
- The route is traced in Rust using ICMP Echo with an increasing IPv4 TTL or IPv6 hop limit. The app does not launch `ping`, `traceroute`, a shell, or another process.
- Hop statistics persist for the current run. A route change is shown as a separate hop/IP entry; the table is bounded to 96 entries. Statistics use constant memory per entry.
- Loss is the percentage of that row's probes which received a reply. A router can rate-limit or filter ICMP responses, so a missing hop reply does not establish that forwarded traffic was lost or that the destination is down.
- Best, average, and worst RTT use received probes. Jitter is the mean absolute difference between consecutive successful RTTs for the same hop and IP.
- Reverse DNS names are shown when the system resolver returns one. They are informational and are not used to identify route completion.

## Development

Requirements: Rust stable, Node.js 22, npm, and the platform dependencies listed in [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run dev
```

Frontend checks:

```sh
npm run typecheck
npm run lint
npm run build
```

Rust checks (from `src-tauri`):

```sh
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

Build a local installer with `npm run tauri build`. The default configuration produces install packages without updater signatures. The signed release workflow overlays `src-tauri/tauri.release.conf.json` and requires the updater key described below.

## Platform notes

### Windows x64

The application uses the Windows ICMP socket path supplied by the Rust traceroute library. Administrator access is generally not required, but Windows Firewall or network policy can suppress ICMP Time Exceeded and Destination Unreachable replies. The workflow builds an NSIS installer; that is the Windows updater format.

### Linux x64

The application first attempts an unprivileged ICMP datagram socket. This can depend on the system's `net.ipv4.ping_group_range` setting. If the system denies that socket, the library can fall back to a raw ICMP socket, which requires `CAP_NET_RAW` or elevated privileges. LanPinger does not elevate itself. Check the application error and your distribution's policy before changing socket permissions.

The workflow packages `.deb`, `.rpm`, and AppImage installers. Tauri Updater 2 uses the AppImage as the supported Linux updater artifact; `.deb` and `.rpm` remain manual installation packages and are not listed in `latest.json`.

### macOS Apple Silicon

The workflow builds an ARM64 `.app`/DMG. Tauri Updater 2 uses the signed `.app.tar.gz` archive, not the DMG. ICMP responses may be filtered by the host, local firewall, VPN, or upstream network. This repository's current local build environment is Windows, so macOS runtime behavior must be confirmed by the macOS CI build and a device-level smoke check.

## Settings and privacy

The trace interval and theme are kept in the webview's local storage. Previous installations migrate the former five-second default to one second once; later user selections persist. Window coordinates are saved as physical pixels under Tauri's application config directory, after a short movement debounce. Window size is set in logical pixels and fitted to the monitor work area, including after a display scale-factor change. The window is shown only after React has rendered the first screen. Invalid or off-screen saved coordinates are discarded and the window is centered on an available display.

LanPinger does not use accounts, telemetry, cloud sync, external font services, or a hosted runtime. Destination names and probe traffic are sent only to the local system resolver and the networks involved in the user's explicit trace. The updater checks GitHub for a signed application artifact at launch or when requested; it does not include the monitored host in that request. Export files contain the displayed route statistics.

## Updates and releases

See [docs/releasing.md](docs/releasing.md) for the signed updater setup, workflow, exact artifact formats, GitHub secrets, stable / preview policy, and troubleshooting. The updater endpoint is configured for:

```text
https://github.com/megoRU/LanPinger/releases/latest/download/latest.json
```

The public key placeholder in `src-tauri/tauri.conf.json` must be replaced before a signed release. The release workflow deliberately fails until the real public key and private signing secrets are configured; it never publishes empty or unsigned updater entries.

## Troubleshooting

- **DNS lookup failed or timed out:** verify the host spelling and local DNS configuration. Resolution has an eight-second timeout.
- **ICMP socket permission denied:** on Linux, inspect `net.ipv4.ping_group_range` and the application's socket capability policy. On Windows, check firewall policy for ICMP errors. Do not infer application data loss from a router that does not answer probes.
- **Every hop shows no reply:** a VPN, local firewall, router, or upstream network may filter ICMP. This is an inconclusive diagnostic result, not proof that the destination is unreachable.
- **Updater check failed:** configure the Tauri updater public key and GitHub Actions signing secrets, then publish a stable release containing `latest.json` and all three signed updater artifacts.
- **Window opens centered after display changes:** LanPinger only restores a saved position if at least a 64 × 64 physical-pixel area intersects a connected monitor.

## Project files

- `src-tauri/src/monitor.rs`: asynchronous route worker, cancellation, bounded per-hop aggregation, loss/RTT/jitter calculations.
- `src-tauri/src/target.rs`: destination validation, DNS resolution, and input tests.
- `src-tauri/src/window_position.rs`: fixed-window position restore and debounced persistence.
- `src/App.tsx`, `src/styles.css`: desktop interface, table, export, preferences, and update controls.
- `.github/workflows/test.yml`: CI tests and static checks.
- `.github/workflows/build-tauri.yml`: Windows, Linux, and macOS packages and signed release publication.
