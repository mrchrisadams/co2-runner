// util/exists.ts — tiny async file-exists helper.
// stat() throws on missing files; wrapping it makes the call site
// read more naturally as `await exists(path)`.

import { stat } from "node:fs/promises";

export async function exists(path: string | URL): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return false;
    // Permission errors etc. — treat as "not present" for our purposes.
    return false;
  }
}
