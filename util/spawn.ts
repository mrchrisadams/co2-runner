// util/spawn.ts — child_process.spawn wrapper exposing the subset of
// the previous runtime's Command ergonomics this codebase uses:
//   - `new Command(cmd, { args, cwd, env, stdout, stderr })`
//   - `.spawn()` → { stdout, stderr (Web ReadableStreams), status }
//   - `.output()` → { success, code, stdout, stderr (Uint8Arrays) }
//
// Node's stdout/stderr are converted with Readable.toWeb so existing
// `.getReader()` call sites keep working.

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

type StreamMode = "piped" | "inherit" | "null";

export interface CommandOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdout?: StreamMode;
  stderr?: StreamMode;
}

export interface CommandStatus {
  success: boolean;
  code: number;
}

export interface CommandOutput {
  success: boolean;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface SpawnedChild {
  pid: number | undefined;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<CommandStatus>;
}

function toWeb(stream: Readable | null): ReadableStream<Uint8Array> {
  if (!stream) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

function stdioFor(mode: StreamMode | undefined): "pipe" | "inherit" | "ignore" {
  if (mode === "piped") return "pipe";
  if (mode === "null") return "ignore";
  // Command defaults stdout/stderr to "inherit".
  return "inherit";
}

export class Command {
  readonly #cmd: string;
  readonly #opts: CommandOptions;

  constructor(cmd: string, opts: CommandOptions = {}) {
    this.#cmd = cmd;
    this.#opts = opts;
  }

  #spawnNode(
    stdout: "pipe" | "inherit" | "ignore",
    stderr: "pipe" | "inherit" | "ignore",
  ): ChildProcess {
    return nodeSpawn(this.#cmd, this.#opts.args ?? [], {
      cwd: this.#opts.cwd,
      // NOTE: this MERGES env over the parent env (the previous runtime's
      // Command REPLACED the environment when env was given) — callers must
      // blank keys explicitly if they need isolation.
      env: this.#opts.env ? { ...process.env, ...this.#opts.env } : process.env,
      stdio: ["ignore", stdout, stderr],
    });
  }

  spawn(): SpawnedChild {
    const child = this.#spawnNode(
      stdioFor(this.#opts.stdout),
      stdioFor(this.#opts.stderr),
    );
    const status = new Promise<CommandStatus>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ success: code === 0, code: code ?? 1 });
      });
    });
    return {
      pid: child.pid,
      stdout: toWeb(child.stdout),
      stderr: toWeb(child.stderr),
      status,
    };
  }

  async output(): Promise<CommandOutput> {
    const child = this.#spawnNode("pipe", "pipe");
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      success: code === 0,
      code: code ?? 1,
      stdout: new Uint8Array(Buffer.concat(stdout)),
      stderr: new Uint8Array(Buffer.concat(stderr)),
    };
  }
}
