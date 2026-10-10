// scripts/build-cli.mjs — build the single-file CLI binary for the host
// platform (`npm run compile`; Phase 7 adds the CI build matrix):
//
//   1. esbuild-bundle main.ts → dist/co2-runner.bundle.js (CommonJS — Node
//      SEA only supports CJS main scripts)
//   2. copy the host Node binary to dist/co2-runner-<triple>, generate the
//      SEA blob (node --experimental-sea-config), inject it with postject,
//      and re-sign ad-hoc on macOS (codesign --remove-signature before
//      injection, codesign --sign - after)
//
// KNOWN LIMITATION (Playwright from inside the SEA binary): in an SEA,
// process.execPath is the SEA binary itself — not a Node runtime — and
// node_modules is not embedded, so the `node <playwright-cli> ...`
// subprocess spawns in util/playwright-cli.ts (browser install, codegen,
// .spec.js journeys) cannot run from the binary. `--help` and `serve`
// (in-process functionality) work; the Playwright payload story is decided
// in Phase 7 / CI. To keep those packages out of the bundle without
// breaking startup, playwrightStubPlugin below replaces the
// playwright/@playwright/test imports with a stub that fails lazily — only
// when something actually calls into Playwright.
//
// Top-level await: main.ts uses top-level await, which esbuild cannot emit
// in CommonJS output, so tlaEntryPlugin wraps the entry body in an async
// IIFE while hoisting its import statements above it. tsx runs main.ts
// unchanged, and no other module in the graph has top-level await.
//
// Dashboard embedding: ui/components.ts reads the __DASHBOARD_JS__ define
// (contents of ui/dashboard.js) in the bundle and falls back to a disk read
// under tsx. Grid-intensity data is inlined by esbuild's JSON loader via the
// plain import in runner/co2.ts.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

// ── esbuild plugins ─────────────────────────────────────────────────────────

// main.ts is the only module in the graph with top-level await. Split its
// leading import block from the rest of the file, hoist the imports back
// above an async IIFE that wraps the body, and let esbuild bundle the
// CommonJS-safe result. A non-contiguous import block fails the build loudly.
const tlaEntryPlugin = {
  name: "co2-runner:wrap-entry-tla",
  setup(build) {
    build.onLoad({ filter: /(^|\/)main\.ts$/ }, (args) => {
      const lines = readFileSync(args.path, "utf8").split("\n");
      const imports = [];
      let i = 0;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t === "" || t.startsWith("//")) {
          imports.push(lines[i]);
          i++;
          continue;
        }
        if (!/^import\b/.test(t)) break;
        // Consume one import statement (may span multiple lines).
        let depth = 0;
        while (i < lines.length) {
          imports.push(lines[i]);
          for (const ch of lines[i]) {
            if ("([{".includes(ch)) depth++;
            else if (")]}".includes(ch)) depth--;
          }
          const done = depth <= 0 && /;\s*$/.test(lines[i].trim());
          i++;
          if (done) break;
        }
      }
      const body = lines.slice(i).join("\n");
      if (/(^|\n)\s*import\b/.test(body)) {
        throw new Error(
          "main.ts: import statement found outside the leading import block; " +
            "extend the wrap-entry-tla plugin in scripts/build-cli.mjs",
        );
      }
      return {
        contents: imports.join("\n") +
          "\n(async () => {\n" +
          body +
          "\n})().catch((err) => {\n  console.error(err);\n  process.exit(1);\n});\n",
        loader: "ts",
      };
    });
  },
};

// playwright/@playwright/test must never be bundled into the binary (they
// are subprocess-resolved at runtime — see the limitation note above).
// Simply marking them external keeps eager require() calls, which would
// crash the SEA at startup (require() inside an SEA only loads builtins).
// A stub module keeps them out of the bundle and defers the failure to
// first use, with a message that explains the situation.
const playwrightStubPlugin = {
  name: "co2-runner:playwright-stub",
  setup(build) {
    build.onResolve(
      { filter: /^(playwright|@playwright\/test)(\/.+)?$/ },
      (args) => ({ path: args.path, namespace: "playwright-stub" }),
    );
    build.onLoad({ filter: /.*/, namespace: "playwright-stub" }, () => ({
      contents: "const unavailable = (name) => () => {\n" +
        "  throw new Error(\n" +
        "    name +\n" +
        '      " is not available inside the co2-runner binary: journeys, ' +
        'browser install and codegen need a Playwright checkout or payload "\n' +
        '      + "(see scripts/build-cli.mjs / Phase 7)"\n' +
        "  );\n" +
        "};\n" +
        "module.exports = new Proxy({}, {\n" +
        '  get: (target, prop) => prop === "__esModule" ? false : unavailable(String(prop)),\n' +
        "});\n",
      loader: "js",
    }));
  },
};

// ── 1. esbuild bundle ───────────────────────────────────────────────────────

const bundlePath = join(dist, "co2-runner.bundle.js");
const dashboardSource = readFileSync(join(root, "ui", "dashboard.js"), "utf8");

await build({
  entryPoints: [join(root, "main.ts")],
  outfile: bundlePath,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  minify: false,
  sourcemap: false,
  define: { __DASHBOARD_JS__: JSON.stringify(dashboardSource) },
  plugins: [tlaEntryPlugin, playwrightStubPlugin],
  logLevel: "info",
});

// ── 2. Node SEA ─────────────────────────────────────────────────────────────

// Rust-style triple matching the old `deno compile` artifacts
// (see .github/workflows/build.yml).
const arch = process.arch === "arm64"
  ? "aarch64"
  : process.arch === "x64"
  ? "x86_64"
  : process.arch;
const osName = process.platform === "darwin"
  ? "apple-darwin"
  : process.platform === "linux"
  ? "unknown-linux-gnu"
  : process.platform === "win32"
  ? "pc-windows-msvc"
  : process.platform;
const exeSuffix = process.platform === "win32" ? ".exe" : "";
const binPath = join(dist, `co2-runner-${arch}-${osName}${exeSuffix}`);
const blobPath = join(dist, "co2-runner.sea.blob");
const seaConfigPath = join(dist, "sea-config.json");

function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} exited with status ${r.status}`);
  }
}

// The blob must be generated by the same Node version that will run it.
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ) + "\n",
);

rmSync(binPath, { force: true });
copyFileSync(process.execPath, binPath);
if (process.platform === "darwin") {
  run("codesign", ["--remove-signature", binPath]);
}

run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

// Resolve postject's JS entry (not the node_modules/.bin shim — that is a
// POSIX shell script, which Windows cannot exec).
const postjectCli = createRequire(import.meta.url).resolve(
  "postject/dist/cli.js",
);

run(
  process.execPath,
  [
    postjectCli,
    binPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin"
      ? ["--macho-segment-name", "NODE_SEA"]
      : []),
  ],
);

if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", binPath]);
}

console.log(`✅ built ${binPath}`);
