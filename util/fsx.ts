// util/fsx.ts — Deno-shaped filesystem helpers over node:fs/promises.
//
// Call sites were written against Deno's async fs API; this keeps their
// shapes (Uint8Array reads, { isFile, isDirectory, size } stats, etc.)
// while the runtime underneath is Node.

import {
  chmod as nodeChmod,
  mkdir as nodeMkdir,
  mkdtemp,
  readdir,
  readFile as nodeReadFile,
  realpath,
  rm,
  stat as nodeStat,
  symlink as nodeSymlink,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function readTextFile(path: string | URL): Promise<string> {
  return await nodeReadFile(path, "utf8");
}

export async function writeTextFile(
  path: string | URL,
  data: string,
): Promise<void> {
  await nodeWriteFile(path, data, "utf8");
}

export async function writeFile(
  path: string | URL,
  data: Uint8Array,
): Promise<void> {
  await nodeWriteFile(path, data);
}

export async function readFile(path: string | URL): Promise<Uint8Array> {
  return await nodeReadFile(path);
}

export async function ensureDir(path: string): Promise<void> {
  await nodeMkdir(path, { recursive: true });
}

export async function mkdir(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  await nodeMkdir(path, { recursive: options?.recursive ?? false });
}

export async function remove(
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  await rm(path, { recursive: options?.recursive ?? false, force: false });
}

export async function makeTempFile(
  options?: { prefix?: string; suffix?: string },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), options?.prefix ?? "co2-runner-"));
  const file = join(dir, `tmp${options?.suffix ?? ""}`);
  await nodeWriteFile(file, "");
  return file;
}

export async function makeTempDir(
  options?: { prefix?: string },
): Promise<string> {
  return await mkdtemp(join(tmpdir(), options?.prefix ?? "co2-runner-"));
}

export async function realPath(path: string): Promise<string> {
  return await realpath(path);
}

export async function chmod(path: string, mode: number): Promise<void> {
  await nodeChmod(path, mode);
}

export async function symlink(
  target: string,
  path: string,
  type?: "dir" | "file" | "junction",
): Promise<void> {
  await nodeSymlink(target, path, type);
}

export async function readDir(
  path: string,
): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
  }));
}

export async function stat(
  path: string,
): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
  const s = await nodeStat(path);
  return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
}
