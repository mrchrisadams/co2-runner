// Unit tests for util/deno-bin.ts.
//
// Most of the surface is lookup-and-spawn, which is hard to unit-test
// without mocking `Deno.Command`. These tests pin the lookup candidates
// (priority order is a public contract — bundled binary first, then
// DENO_BIN env, then ~/.deno/bin, then Homebrew, etc.) and the error
// message.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  bundledDenoPath,
  denoBinaryCandidates,
  DenoNotFoundError,
} from "../../util/deno-bin.ts";

Deno.test("denoBinaryCandidates: returns at least the well-known fallbacks", () => {
  const candidates = denoBinaryCandidates();
  // The list MUST always include these, regardless of bundled-path
  // detection, so dev-mode runs (no .app bundle) still work:
  //   ~/.deno/bin/deno, /opt/homebrew/bin/deno, /usr/local/bin/deno,
  //   /usr/bin/deno, "deno" (bare PATH lookup)
  assert(candidates.includes("/opt/homebrew/bin/deno"));
  assert(candidates.includes("/usr/local/bin/deno"));
  assert(candidates.includes("/usr/bin/deno"));
  assert(candidates.includes("deno"));
  // /opt/homebrew/bin must come before /usr/local/bin (Apple Silicon
  // Homebrew before Intel Homebrew).
  const aarchIdx = candidates.indexOf("/opt/homebrew/bin/deno");
  const intelIdx = candidates.indexOf("/usr/local/bin/deno");
  assert(aarchIdx > -1 && intelIdx > -1 && aarchIdx < intelIdx);
});

Deno.test("denoBinaryCandidates: bundled app path is first when running from .app bundle", () => {
  // We can't reliably run a test from inside a .app bundle, so this
  // test instead asserts the contract: IF bundledDenoPath() returns
  // a path, it MUST be the first candidate.
  const candidates = denoBinaryCandidates();
  const bundled = bundledDenoPath();
  if (bundled !== null) {
    assertEquals(candidates[0], bundled);
  }
});

Deno.test("denoBinaryCandidates: DENO_BIN env added after bundled path", () => {
  Deno.env.set("DENO_BIN", "/custom/path/to/deno");
  try {
    const candidates = denoBinaryCandidates();
    const bundled = bundledDenoPath();
    if (bundled !== null) {
      // Bundled comes first; DENO_BIN is second.
      assertEquals(candidates[0], bundled);
      assertEquals(candidates[1], "/custom/path/to/deno");
    } else {
      // No .app bundle → DENO_BIN is first.
      assertEquals(candidates[0], "/custom/path/to/deno");
    }
  } finally {
    Deno.env.delete("DENO_BIN");
  }
});

Deno.test("denoBinaryCandidates: includes ~/.deno/bin/deno when HOME is set", () => {
  const home = Deno.env.get("HOME");
  if (!home) return; // skip on platforms without HOME
  const candidates = denoBinaryCandidates();
  assert(candidates.includes(`${home}/.deno/bin/deno`));
});

Deno.test("bundledDenoPath: returns null in dev mode (not inside a .app)", () => {
  // When run via `deno test`, Deno.execPath() returns the actual deno
  // binary at ~/.deno/bin/deno (or similar) — not a .app bundle path.
  // bundledDenoPath() must return null in that case.
  const result = bundledDenoPath();
  assertEquals(result, null);
});

Deno.test("DenoNotFoundError has a helpful message pointing at install.sh", () => {
  const err = new DenoNotFoundError();
  assertEquals(err.name, "DenoNotFoundError");
  // The error message MUST mention the install command so users who hit
  // this from the desktop app know exactly what to do.
  assertStringIncludes(err.message, "deno.land/install.sh");
  // Should also mention DENO_BIN so power users know they can override.
  assertStringIncludes(err.message, "DENO_BIN");
  // Should also mention the bundled-binary fallback (option 1 in the
  // error message) so users on an older build know to upgrade.
  assertStringIncludes(err.message, "CO2Runner.dmg");
});
