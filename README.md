# ROM Trader

An automated momentum bot for [Kalshi](https://kalshi.com) prediction markets, as
a single Electron desktop app. One language (TypeScript), no Python sidecar, no
RPC layer, no account, no telemetry.

Download the Windows installer from **[romapps.xyz](https://romapps.xyz)** or the
[releases page](https://github.com/romanstma-cpu/rom-apps/releases/latest).

> **This is not a proven edge, and it is not financial advice.** The strategy is a
> simple momentum heuristic with no demonstrated profitability; fees and spread
> work against it. It ships in dry-run and you can lose real money if you turn
> live mode on. You are responsible for every order it places.

## What it does

- Scans the ~40 most liquid Kalshi markets closing within the next 2 hours
- Buys YES when the mid-price rises past your momentum trigger over a 3-sample
  lookback; exits on take-profit, stop-loss, or momentum reversal
- Filters out wide spreads and markets outside your price band — buying at the
  ask while valuing at the bid means a wide spread is an instant unrealized loss
- **Dry-run by default.** Live orders require saved API keys, an explicit toggle,
  and a confirmation.

## Pages

| Page | What's there |
| --- | --- |
| Dashboard | Balance, session / today / all-time P&L, win rate, equity curve, scanner summary |
| Positions | Open positions with entry, bid, peak, unrealized P&L; click a ticker to open it on Kalshi |
| Signals | Every market the last sweep looked at and the reason it did or didn't qualify |
| History | Closed trades with exit reasons, summary stats, CSV export |
| Strategies | Three presets plus your own saved setups (credentials are never stored in a setup) |
| Connection | API keys and a Test Connection button that round-trips a real Kalshi call |
| Settings | Sizing, entry/exit, market filters, daily loss limit, startup options |
| Logs | Live engine log, filterable by level |

## Safety rails

- **Daily loss limit** — the engine stops itself once today's closed trades lose
  more than the configured amount
- **Flatten** — closes every open position at the current bid in one click
- **Crash reporting** — a startup failure writes the real error, stack trace and
  environment to `crash.log` in the data folder and shows it in a readable
  dialog, rather than Electron's blank "A JavaScript error occurred" box
- **Single instance** — a second launch focuses the running window instead of
  starting a rival engine against the same files

## Run it

```
npm install
npm run start
```

## Build a Windows installer

```
npm run dist
```

Output lands in `release/`. The installer is unsigned, so SmartScreen will warn
about an unknown publisher on first launch.

`winget/` holds validated manifests for the Windows Package Manager. To publish
a version, refresh `PackageVersion`, `InstallerUrl` and `InstallerSha256`, then
copy the three files into `manifests/r/ROM/Trader/<version>/` in a fork of
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) and open a
pull request. Check them first with `winget validate --manifest winget`.

## Layout

```
electron/main.ts            window, IPC wiring, single-instance lock
electron/preload.ts         contextBridge API surface
electron/crashlog.ts        fatal-error capture -> crash.log + dialog
electron/engine/engine.ts   momentum engine (entries, exits, signals, P&L)
electron/engine/kalshi.ts   Kalshi REST client (public data + RSA-signed auth)
electron/engine/store.ts    settings, history, profiles, equity (JSON in userData)
electron/engine/strategies.ts  shipped presets
src/                        React UI (Vite)
src/ui.tsx                  shared components: toasts, confirms, fields, chart
test/headless.ts            headless engine smoke test:
                            npm run build, then
                            esbuild test/headless.ts --bundle --platform=node
                            --alias:electron=./test/electron-stub.js
                            --outfile=test/headless.js && node test/headless.js
```

Settings, history, saved setups and logs live in
`%APPDATA%/ROM Trader/`.

## Licence

MIT — see [LICENSE](LICENSE).
