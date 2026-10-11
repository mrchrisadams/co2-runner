# Migrating Deno Project to Node or Bun

*Created: 09/10/2026, 21:02:43*

---

**You**

I have found out that the deno runtime is being discontinued. this is a pain for this project I worked on below, which is built using deno:

https://github.com/mrchrisadams/co2-runner

I want to spend some time this weekend converting it to either run on node, or bun, and have feature parity.

Please review the project codebase and outline a plan for migration for both options, explaining the tradeoffs. 

my interest in deno was specifically in deno desktop and the good path for cross compilation to create applications. provide a plan for creating the same GUI apps and CLI apps, using either node or bun as the new underlying runtime.

in your research, for both options please explain your choice of different dependencies to provide the functionality in use that was built into deno

---

**Assistant**

**Short version:** I couldn't find evidence that the Deno runtime is being discontinued, and the Node and Bun routes both lose something Deno gives you today. Playwright is the biggest risk, because Playwright is the one dependency that doesn't behave the same on every runtime.

## 1. Pushing back on the premise

- Deno 2.9.6 was released on 27 August 2026 [^1]. `deno desktop` shipped in 2.9 (June 2026) and is actively documented [^2].
- What was shut down is **Deno Deploy Classic**, the hosting product, on July 20, 2026 [^3][^4]. That is a different thing from the runtime, and it's my best guess at what you heard.
- Ryan Dahl rebutted "Deno is dying" claims in 2025 [^5].
- Where did you read "discontinued"? If it's a headline about Deploy, a weekend of porting buys you little. If you have a primary source I missed, send it.
- Deno also causes you real pain today. You need `--unsafe-proto` for Playwright [^6]. You also ship a 77 MB Deno CLI inside the DMG because the embedded runtime can't run `npm:` entrypoints [^7][^7]. Those are better reasons to migrate than a rumour.

I'll assume you want to migrate regardless.

## 2. Challenging the "cross-compilation" motive

Your CI doesn't cross-compile. The CLI is built on native macOS, Ubuntu and Windows runners, and the desktop app is built only on macOS arm64 [^8][^8]. ADR-004 admits that `desktop:all` would need the right Deno CLI bundled per target, which isn't wired up [^7]. Signing is ad-hoc [^7].

A native-runner CI matrix gives you the same artifacts with any runtime. True cross-compilation is a nice-to-have, not a requirement, and that widens your GUI options.

## 3. What the codebase actually uses

Everything in the repo is plain Web APIs plus a few `Deno.*` calls. The inventory below comes from reading `main.ts`, `runner/*`, `util/deno-bin.ts` and `ui/history.ts`.

| Deno feature in use | Where | Node replacement | Bun replacement |
|---|---|---|---|
| `Deno.serve` + `Request`/`Response` + SSE via `TransformStream` | `main.ts` [^9] | Hono + `@hono/node-server` (my suggestion, not researched) | `Bun.serve({ fetch })`, near drop-in |
| `Deno.args/env/exit/cwd/execPath` | everywhere | `process.argv.slice(2)`, `process.env`, `process.exit`, `process.cwd()`, `process.execPath` | same |
| `Deno.readTextFile/writeTextFile/mkdir/realPath/remove` | `run.ts`, `run-script.ts`, `main.ts` | `node:fs/promises` | same |
| `Deno.Command` (spawn, piped streams) | `codegen.ts`, `install.ts`, `run-script.ts` | `child_process.spawn` | `Bun.spawn` or `node:child_process` |
| `Deno.build.os` (`"darwin"`/`"linux"`/`"windows"`) | `codegen.ts`, `main.ts` [^10] | `process.platform`, which says `"win32"`, not `"windows"`. This breaks `hasGraphicalDisplay` and the `explorer` branch if you don't map it. | same gotcha |
| `node:sqlite` `DatabaseSync` | `ui/history.ts` [^11] | `node:sqlite` as-is. In current Node docs `DatabaseSync` is a deprecated alias for `Database` [^12]. | `node:sqlite` is **not implemented in Bun** [^13], so use `bun:sqlite` behind a small adapter |
| JSON import with `type: "json"` (grid data) | `co2.ts` [^6] | bundler inlines it | `bun build` inlines it |
| `yaml`, `playwright`, `@playwright/test` | npm | same packages | same packages |
| `deno test/lint/check/fmt` | tasks, CI | `node:test` or vitest, eslint, tsc, prettier | `bun test`, same linters |
| `--unsafe-proto`, `-A`, `--allow-scripts` | tasks | not needed. This is a Deno-ism. | not needed |

Also in the repo:
- **Import map aliases:** `deno.json` aliases `path`, `fs`, `sqlite` and `zlib` to `node:` modules [^14]. Replace them with real `node:` imports.
- **`.ts` extension imports:** Node and Bun will need a bundler (esbuild) or `tsx` for these.

## 4. The hard part: Playwright

- Your app uses Playwright three ways: in-process `firefox.launch` (YAML journeys), and subprocess calls for `playwright test`, `codegen` and `install` [^15][^16][^10]. ADR-004 considered in-process replacements and rejected them as fragile, which is still sound [^7].
- **Node:** Playwright's native home. Nothing special is needed.
- **Bun:**
  - Playwright says it doesn't test against Bun and use is at your own risk [^17].
  - `firefox.launch()` hung under Bun 1.3.14 on Windows. It was fixed in a 1.4.0 canary, and `bunx playwright install firefox` segfaulted on 1.3.14 [^18][^18]. Linux was fine [^18].
  - I couldn't confirm whether 1.4 stable has shipped. Check this before committing.
  - `bun build --compile` with Playwright fails on another machine because Playwright reads its own `package.json` through `__dirname`-computed paths, which the compiler can't embed [^19].
- **Bun.WebView** in 1.3.12+ is not a replacement. It uses WebKit on macOS and Chrome elsewhere [^20], while your energy measurement depends on Firefox's profiler.
- **Regression to accept:** `deno compile --include npm:playwright` gives you one binary with Playwright inside, and that's hard to reproduce. For both options, keep Playwright **out** of the binary. Make `co2-runner install` fetch or extract a Playwright payload plus Firefox into `~/.co2-runner/`, and always run Playwright through a real Node process. You already download Firefox on `install`, so this extends an existing step.

## 5. Option A: Node

**Dependencies**
- `esbuild` to bundle, and `tsx` for dev.
- `hono` + `@hono/node-server`.
- `yaml`, `playwright`, `@playwright/test`.
- Built-in `node:sqlite`, `node:test`.

**CLI binary (Node SEA)**
- Node's single-executable feature is "Stability 1.1 – Active development" [^21]. Use `--build-sea` with a JSON config [^21].
- For cross-building, point `executable` at a downloaded Node binary for the target. The Node version must match, and `useCodeCache` and `useSnapshot` must be false [^21].
- Your entry must be a single bundled script, because module loading doesn't read the filesystem [^21].
- Native addons need extracting to a temp file [^21]. You have none today.
- **Caveat:** Node's CI doesn't support macOS x64 and tests only macOS arm64, Windows, and non-Alpine Linux [^21]. Your current build set includes `x86_64-apple-darwin`, so Intel Macs are a parity risk.
- Optional: `useVfs` (Node 26.9+, stability 1.0 "Early development") can embed a `node_modules` tree [^21]. I wouldn't use it here. The docs don't say child processes can read it, and Playwright needs real files.
- **Subprocess problem:** an SEA has no `BUN_BE_BUN` equivalent. My untested idea is that the entry script checks an env var and, if set, `createRequire`s Playwright's CLI from the extracted directory. Then `spawn(process.execPath, …)` runs Playwright through your own binary.

**GUI**
- **Electron (my default).**
  - The main process is Node. `ELECTRON_RUN_AS_NODE` lets the Electron binary run as plain Node [^22], which removes your 77 MB bundled-Deno hack. Keep the `runAsNode` fuse enabled [^23].
  - `BrowserWindow` points at `http://127.0.0.1:port`, so your server and SSE code are unchanged.
  - Cross-building works with electron-builder, but there are limits. macOS code signing only works on macOS, and Windows-from-Linux needs Wine [^24][^24].
  - Size is about 100 MB+ [^25]. That is a regression from Deno's roughly 40 MB with the system webview.
- **Tauri + Node SEA sidecar.**
  - Tauri has an official "Node.js as a sidecar" guide [^26] and an `externalBin` option [^27].
  - It is much smaller (about 2–10 MB for Tauri itself), but per Deno's own comparison it needs a build on each target OS [^25]. That source is Deno's doc, so treat it as biased. It's fine with your native CI matrix.
  - It adds Rust to your toolchain.

## 6. Option B: Bun

**Dependencies**
- Same as Node, but swap in `Bun.serve` and `bun:sqlite`.
- No bundler is needed.

**CLI binary**
- `bun build --compile --target=bun-<os>-<arch>` cross-compiles from any host. Targets are linux, windows and darwin on x64 and arm64, plus musl [^28].
- This is the closest thing to `deno compile --target`, and better than Node SEA on macOS x64.
- Assets embed with `--asset` or `with { type: "file" }` [^28][^28].
- Windows icon and version flags don't work when cross-compiling, except `hideConsole` [^28]. macOS signing is via `codesign` [^28].
- `BUN_BE_BUN=1` makes a compiled binary act as the Bun CLI [^28], which replaces your bundled-Deno trick. But then Playwright runs on Bun, with the risks above. To avoid that, ship a Node binary in the Playwright payload.

**GUI**
- **Electrobun** has Bun as its runtime, system webview or optional CEF, and Zstandard self-extracting bundles [^29][^29].
- Official platforms are macOS 14+, Windows 11 x64 and Ubuntu 24.04+ [^29]. Linux needs GTK3 and WebKitGTK 4.1 [^29].
- It builds on each target OS. I couldn't confirm cross-compilation, and Deno's doc says it isn't supported [^25].
- It is the closest in spirit to `deno desktop`, but it's a young project with no built-in installers [^25].
- Alternatively, use Tauri with a Bun-compiled sidecar.

## 7. Tradeoffs and recommendation

| | Node (SEA + Electron) | Bun (compile + Electrobun) |
|---|---|---|
| Playwright reliability | Best, native | Risky: Windows hang fixed only in canary (as of the thread), compile breakage |
| CLI cross-compile | OK, but macOS x64 unsupported in Node's CI | Excellent, all targets |
| CLI maturity | SEA still "active development" | `--compile` is mature |
| GUI size | ~100 MB+ | ~61 MB per Deno's comparison [^25] |
| GUI cross-compile | electron-builder, with Wine and signing caveats | Per-OS builds |
| SQLite | `node:sqlite`, no change | Adapter needed |
| Port effort | Lowest | Moderate |

**My recommendation:** Node as the runtime, with Playwright running in real Node. Use SEA for the CLI and Electron for the GUI. Revisit Tauri later if size matters. Choose Bun only if you're willing to keep Playwright on a Node subprocess anyway, in which case Bun's main gain is easier CLI cross-compilation.

## 8. Weekend plan (Node route)

1. Replace `Deno.*` with Node equivalents behind a small `platform.ts`, including the `win32` mapping. Move the server to Hono. Switch tests to `node:test`.
2. Run `serve`, `run` and `install` in dev. Remove `--unsafe-proto` and the `findDenoBinary` logic.
3. Bundle with esbuild and build the SEA on your three native CI runners. Smoke-test `--help` and one real journey on Windows.
4. Build the Electron shell, using `ELECTRON_RUN_AS_NODE` for Playwright subprocesses.
5. Defer signing, notarisation and Intel macOS.

Realistically, steps 1–3 are a weekend. Step 4 may spill over. Everything above in sections 3–8 is from the repo and docs I read, except the Hono/esbuild choices and the SEA self-spawn trick, which are my own suggestions and untested.

**References**

[^1]: [Deno (software) - Wikipedia](https://en.wikipedia.org/wiki/Deno_(software)) (1%)
[^2]: [Desktop apps | Deno Docs](https://docs.deno.com/runtime/desktop/) (4%)
[^3]: [Deploy Classic](https://docs.deno.com/deploy/classic/) (0%)
[^4]: [About Deno Deploy](https://docs.deno.com/deploy/) (0%)
[^5]: [Reports of Deno’s demise ‘greatly exaggerated,’ Deno creator says](https://www.infoworld.com/article/3997318/reports-of-denos-demise-greatly-exaggerated-deno-creator-says.html) (0%)
[^6]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/docs/architecture.md) (4%)
[^7]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/docs/adrs/adr-004-bundle-standalone-deno.md) (10%)
[^8]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/.github/workflows/build.yml) (3%)
[^9]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/main.ts) (2%)
[^10]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/runner/codegen.ts) (4%)
[^11]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/ui/history.ts) (1%)
[^12]: [SQLite | Node.js v26.11.1 Documentation](https://nodejs.org/api/sqlite.html) (1%)
[^13]: [Node.js node:sqlite module | API Reference | Bun](https://bun.com/reference/node/sqlite) (1%)
[^14]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/deno.json) (5%)
[^15]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/runner/run.ts) (2%)
[^16]: [raw.githubusercontent.com](https://raw.githubusercontent.com/mrchrisadams/co2-runner/main/runner/run-script.ts) (6%)
[^17]: [[Feature]: Add support for bun · Issue #38095 · microsoft/playwright](https://github.com/microsoft/playwright/issues/38095) (0%)
[^18]: [playwright-core chromium.launch / firefox.launch never resolves under Bun (works under Node)](https://github.com/oven-sh/bun/issues/38579) (7%)
[^19]: [bun  build --compile doesn't work with playwright](https://github.com/oven-sh/bun/issues/27530) (5%)
[^20]: [Bun v1.3.12](https://bun.com/blog/bun-v1.3.12) (1%)
[^21]: [Single executable applications | Node.js v26.11.1 Documentation](https://nodejs.org/api/single-executable-applications.html) (15%)
[^22]: [Environment Variables](https://electronjs.org/docs/latest/api/environment-variables) (0%)
[^23]: [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) (0%)
[^24]: [Multi Platform Build | electron-builder](https://www.electron.build/docs/features/multi-platform-build/) (2%)
[^25]: [Comparison with other tools | Deno Docs](https://docs.deno.com/runtime/desktop/comparison/) (5%)
[^26]: [Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/) (1%)
[^27]: [Embedding External Binaries | Tauri](https://v2.tauri.app/develop/sidecar/) (1%)
[^28]: [Single-file executable | Bun Docs](https://bun.com/docs/bundler/executables) (12%)
[^29]: [blackboardsh/electrobun GitHub Repo](https://github.com/blackboardsh/electrobun) (6%)

---

