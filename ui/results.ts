// ui/results.ts — in-memory store for journey results + progress.
// Mirrors to subscribers via a callback list (used by the SSE endpoint).

import type {
  InstallProgress,
  JourneyProgress,
  JourneyResult,
} from "../types.ts";

type Subscriber = (event: StoreEvent) => void;

export type StoreEvent =
  | { type: "result"; result: JourneyResult }
  | { type: "progress"; progress: JourneyProgress }
  | { type: "install"; install: InstallProgress }
  | { type: "firefox-status"; installed: boolean };

export class ResultsStore {
  results: JourneyResult[] = [];
  firefoxInstalled = false;
  private subscribers = new Set<Subscriber>();

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  push(result: JourneyResult): void {
    this.results.push(result);
    this.emit({ type: "result", result });
  }

  progress(p: JourneyProgress): void {
    this.emit({ type: "progress", progress: p });
  }

  installProgress(p: InstallProgress): void {
    this.emit({ type: "install", install: p });
  }

  setFirefoxInstalled(installed: boolean): void {
    this.firefoxInstalled = installed;
    this.emit({ type: "firefox-status", installed });
  }

  private emit(event: StoreEvent): void {
    for (const cb of this.subscribers) cb(event);
  }
}
