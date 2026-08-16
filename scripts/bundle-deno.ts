// scripts/bundle-deno.ts — downloads the standalone Deno CLI binary and
// embeds it into a built `dist/CO2Runner.app` bundle so subprocess spawns
// (codegen, install, .spec.js runner) work without requiring the user to
// have installed Deno separately.
//
// Invoked by `deno task desktop` AFTER the `deno desktop` build completes.
// Re-codesigns the bundle ad-hoc with --deep so the embedded binary is
// trusted by the parent process's signature.
//
// Usage:
//   deno run -A --allow-net --allow-write --allow-run scripts/bundle-deno.ts [version]
//
// If no version is provided, defaults to the Deno version currently running
// the script (Deno.version.deno).

import { exists } from "../util/exists.ts";

interface Platform {
  /** Target triple, e.g. `aarch64-apple-darwin`. */
  triple: string;
  /** Whether this platform's deno binary needs .exe suffix. */
  exeSuffix: string;
  /** Used to error out on platforms we can't bundle for (e.g. Windows DMG build). */
  isMacos: boolean;
}

function detectPlatform(): Platform {
  const plat = Deno.build.os;
  const arch = Deno.build.arch;
  if (plat === "darwin") {
    return {
      triple: `${arch}-apple-darwin`,
      exeSuffix: "",
      isMacos: true,
    };
  }
  if (plat === "linux") {
    return {
      triple: `${arch}-unknown-linux-gnu`,
      exeSuffix: "",
      isMacos: false,
    };
  }
  if (plat === "windows") {
    return {
      triple: `${arch}-pc-windows-msvc`,
      exeSuffix: ".exe",
      isMacos: false,
    };
  }
  throw new Error(`unsupported platform: ${plat}/${arch}`);
}

const APPLE_APP_BUNDLE_DENO_PATH = "Contents/Resources/deno/deno";

/**
 * Absolute path to the bundled deno binary inside the .app bundle.
 * Computed by walking up from Deno.execPath() (which is
 * CO2Runner.app/Contents/MacOS/laufey_webview in the desktop binary)
 * to find the sibling Resources/ directory.
 */
export function bundledDenoPath(): string | null {
  const execPath = Deno.execPath();
  // Walk up: .../Contents/MacOS/laufey_webview → .../Contents
  const macosIdx = execPath.lastIndexOf("/MacOS/");
  if (macosIdx === -1) return null; // not running from inside a .app bundle
  const contentsDir = execPath.substring(0, macosIdx);
  return `${contentsDir}/${APPLE_APP_BUNDLE_DENO_PATH}`;
}

interface DownloadResult {
  ok: boolean;
  message: string;
}

async function downloadDeno(
  version: string,
  platform: Platform,
  destDir: string,
): Promise<DownloadResult> {
  const url =
    `https://dl.deno.land/release/v${version}/deno-${platform.triple}.zip`;
  console.log(`↓ Downloading Deno CLI v${version} for ${platform.triple}...`);
  console.log(`  → ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    return {
      ok: false,
      message: `download failed: HTTP ${res.status} ${res.statusText}`,
    };
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  console.log(
    `  ✓ downloaded ${(zipBytes.length / 1024 / 1024).toFixed(1)} MB`,
  );

  // Write the zip to a temp file, then unzip.
  const tmpZip = await Deno.makeTempFile({ suffix: ".zip" });
  try {
    await Deno.writeFile(tmpZip, zipBytes);
    await Deno.mkdir(destDir, { recursive: true });

    // Use the system `unzip` command — robust + cross-version, and
    // we already have it via Deno.Command. Deno doesn't have a built-in
    // unzip in the stdlib yet (deno_zip is JSR-experimental).
    const cmd = new Deno.Command("unzip", {
      args: ["-o", tmpZip, "-d", destDir],
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await cmd.output();
    if (!status.success) {
      return {
        ok: false,
        message: `unzip failed (exit ${status.code})`,
      };
    }
    // Verify the binary exists + is executable.
    const denoPath = `${destDir}/deno${platform.exeSuffix}`;
    if (!await exists(denoPath)) {
      return { ok: false, message: `unzip didn't produce ${denoPath}` };
    }
    await Deno.chmod(denoPath, 0o755);
    return { ok: true, message: denoPath };
  } finally {
    await Deno.remove(tmpZip).catch(() => {});
  }
}

async function codesignAdhoc(appPath: string): Promise<void> {
  // Re-sign the bundle with --deep so the embedded deno binary is
  // trusted by the parent's ad-hoc signature. macOS would otherwise
  // refuse to launch the parent (or show a "damaged" warning) because
  // the bundled resources have changed since the original signature
  // was computed by `deno desktop`.
  console.log(`✎ Re-codesigning ${appPath} (ad-hoc, deep)...`);
  const cmd = new Deno.Command("codesign", {
    args: ["--force", "--sign", "-", "--deep", appPath],
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await cmd.output();
  if (!status.success) {
    throw new Error(`codesign failed (exit ${status.code})`);
  }
  console.log("  ✓ signed");
}

/**
 * Regenerate the .dmg at <app-path>.dmg (e.g. dist/CO2Runner.app →
 * dist/CO2Runner.dmg) so it includes the bundled deno binary. The DMG
 * that `deno desktop` produces initially has stale contents (no deno
 * inside); the user ends up downloading + installing a 36 MB DMG that
 * still has the bug.
 *
 * Strategy: build the DMG from a staging directory containing the .app
 * + a /Applications symlink so users can drag-to-install.
 */
async function regenerateDmg(appPath: string): Promise<string> {
  const dmgPath = appPath.replace(/\.app$/, ".dmg");
  const stagingDir = await Deno.makeTempDir();

  try {
    // Symlink to /Applications so the DMG opens with a drag-to-Install
    // shortcut alongside the app icon.
    await Deno.symlink("/Applications", `${stagingDir}/Applications`);
    // Copy the freshly-signed .app into staging.
    await copyDir(appPath, `${stagingDir}/${basename(appPath)}`);

    console.log(`📦 Regenerating ${dmgPath}...`);
    const cmd = new Deno.Command("hdiutil", {
      args: [
        "create",
        "-volname",
        "CO2 Runner",
        "-srcfolder",
        stagingDir,
        "-ov", // overwrite if exists
        "-format",
        "UDZO", // compressed
        dmgPath,
      ],
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await cmd.output();
    if (!status.success) {
      throw new Error(`hdiutil failed (exit ${status.code})`);
    }
    console.log("  ✓ DMG regenerated");
    return dmgPath;
  } finally {
    await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  // Use `cp -R` rather than re-implementing recursive copy: it preserves
  // symlinks, permissions, and xattrs (including codesign signatures).
  const cmd = new Deno.Command("cp", {
    args: ["-R", src, dest],
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await cmd.output();
  if (!status.success) {
    throw new Error(`cp -R failed (exit ${status.code})`);
  }
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.substring(idx + 1);
}

async function main() {
  const version = Deno.args[0] ?? Deno.version.deno;
  if (!version) {
    console.error(
      "no Deno version provided and Deno.version.deno is empty — pass an explicit version",
    );
    Deno.exit(1);
  }

  const appPath = Deno.args[1] ?? "dist/CO2Runner.app";
  if (!await exists(appPath)) {
    console.error(
      `app bundle not found at ${appPath}. Run \`deno task desktop\` (without the trailing bundle step) first.`,
    );
    Deno.exit(1);
  }

  const platform = detectPlatform();
  if (!platform.isMacos) {
    console.error(
      `bundling Deno into a .app is macOS-only; this machine is ${Deno.build.os}. ` +
        `For Linux/Windows, ship the standalone deno binary alongside the app and set DENO_BIN.`,
    );
    Deno.exit(1);
  }

  // destDir is .../Contents/Resources/deno
  const destDir = `${appPath}/${
    APPLE_APP_BUNDLE_DENO_PATH.substring(
      0,
      APPLE_APP_BUNDLE_DENO_PATH.lastIndexOf("/"),
    )
  }`;
  const result = await downloadDeno(version, platform, destDir);
  if (!result.ok) {
    console.error(`✗ ${result.message}`);
    Deno.exit(1);
  }
  console.log(`  ✓ deno binary placed at ${result.message}`);

  await codesignAdhoc(appPath);

  // Regenerate the DMG so it contains the freshly-bundled + signed .app.
  // `deno desktop` creates the DMG before bundle-deno.ts runs, so without
  // this step the shipped .dmg would have the pre-bundle contents.
  const dmgPath = await regenerateDmg(appPath);

  // Report final sizes.
  const sizeDeno = (await Deno.stat(result.message)).size;
  const sizeApp = await totalDirSize(appPath);
  const sizeDmg = (await Deno.stat(dmgPath)).size;
  console.log(
    `\n✅ Bundled Deno ${version} into ${appPath} (${
      (sizeDeno / 1024 / 1024).toFixed(1)
    } MB)`,
  );
  console.log(
    `   App bundle: ${(sizeApp / 1024 / 1024).toFixed(1)} MB | ` +
      `DMG: ${(sizeDmg / 1024 / 1024).toFixed(1)} MB`,
  );
}

async function totalDirSize(path: string): Promise<number> {
  let total = 0;
  const walk = async (p: string) => {
    for await (const entry of Deno.readDir(p)) {
      const full = `${p}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile) {
        const s = await Deno.stat(full);
        total += s.size;
      }
    }
  };
  await walk(path);
  return total;
}

if (import.meta.main) {
  await main();
}
