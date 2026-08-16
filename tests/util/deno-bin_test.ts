// Unit tests for util/deno-bin.ts.
//
// Most of the surface is lookup-and-spawn, which is hard to unit-test
// without mocking `Deno.Command`. These tests pin the lookup candidates
// (priority order is a public contract — DENO_BIN first, then
// ~/.deno/bin, then Homebrew, etc.) and the error message.

import { assert, assertStringIncludes } from "jsr:@std/assert";
import {
  denoBinaryCandidates,
  DenoNotFoundError,
} from "../../util/deno-bin.ts";

Deno.test("denoBinaryCandidates: returns at least the well-known fallbacks", () => {
  const candidates = denoBinaryCandidates();
  // The list MUST always include these, in this priority order, so
  // subprocess spawns work regardless of how the binary was launched:
  //   1. (optional) DENO_BIN env override (tested separately)
  //   2. ~/.deno/bin/deno (user install default on macOS/Linux)
  //   3. /opt/homebrew/bin/deno (Apple Silicon Homebrew)
  //   4. /usr/local/bin/deno (Intel Homebrew; also generic BSD/Linux)
  //   5. /usr/bin/deno (Linux distro install)
  //   6. "deno" (bare PATH lookup, works in dev mode)
  assert(candidates.includes("/opt/homebrew/bin/deno"));
  assert(candidates.includes("/usr/local/bin/deno"));
  assert(candidates.includes("/usr/bin/deno"));
  assert(candidates.includes("deno"));
  // ~Specifically, /opt/homebrew/bin must come before /usr/local/bin
  // (Apple Silicon users with both paths installed should pick the
  // arch-native Homebrew first).
  const aarchIdx = candidates.indexOf("/opt/homebrew/bin/deno");
  const intelIdx = candidates.indexOf("/usr/local/bin/deno");
  assert(aarchIdx > -1 && intelIdx > -1 && aarchIdx < intelIdx);
});

Deno.test("denoBinaryCandidates: prepends DENO_BIN env when set", () => {
  Deno.env.set("DENO_BIN", "/custom/path/to/deno");
  try {
    const candidates = denoBinaryCandidates();
    // DENO_BIN wins — must be the first entry.
    assertEquals(candidates[0], "/custom/path/to/deno");
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

Deno.test("DenoNotFoundError has a helpful message pointing at install.sh", () => {
  const err = new DenoNotFoundError();
  assertEquals(err.name, "DenoNotFoundError");
  // The error message MUST mention the install command so users who hit
  // this from the desktop app know exactly what to do.
  assertStringIncludes(err.message, "deno.land/install.sh");
  // Should also mention DENO_BIN so power users know they can override.
  assertStringIncludes(err.message, "DENO_BIN");
});

// deno-lint-ignore no-unused-vars
import { assertEquals } from "jsr:@std/assert";
