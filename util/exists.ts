// util/exists.ts — tiny async file-exists helper.
// Deno.stat() throws on missing files; wrapping it makes the call site
// read more naturally as `await exists(path)`.

export async function exists(path: string | URL): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    // Permission errors etc. — treat as "not present" for our purposes.
    return false;
  }
}
