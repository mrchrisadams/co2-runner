// Shared types for co2-runner.

// A narrower version of Playwright's `loadState` union. Defined locally so
// PageLike doesn't need to depend on the Playwright type definitions.
export type LoadState = "load" | "domcontentloaded" | "networkidle";

// A narrower version of Playwright's `Locator.waitFor` state union.
export type WaitForState = "attached" | "detached" | "visible" | "hidden";

// Structural type describing the subset of Playwright's Page API that
// executeStep relies on. Defined here so the runner doesn't need to import
// the full Playwright types (which require --allow-sys at load time), and
// so the unit tests can pass a MockPage without `as any` casts.
export interface PageLike {
  goto(url: string): Promise<unknown>;
  waitForLoadState(state?: LoadState): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  evaluate(expr: string): Promise<unknown>;
  mouse: {
    wheel(x: number, y: number): Promise<unknown>;
  };
  locator(selector: string): {
    click(): Promise<unknown>;
    fill(value: string): Promise<unknown>;
    waitFor(
      opts?: { state?: WaitForState; timeout?: number },
    ): Promise<unknown>;
  };
}

export interface JourneyConfig {
  name: string;
  url?: string;
  browser?: "firefox";
  headless?: boolean;
  steps: Step[];
}

export type Step =
  | { action: "goto"; url: string; waitFor?: LoadState }
  | { action: "click"; selector: string; waitFor?: LoadState }
  | { action: "fill"; selector: string; value: string }
  | { action: "scroll"; distance: number; human?: boolean }
  | { action: "wait"; ms: number }
  | { action: "waitForSelector"; selector: string };

export interface JourneyResult {
  name: string;
  mWh: number;
  joules: number;
  timestamp: string;
  profilePath: string;
}

export interface JourneyProgress {
  name: string;
  stepIndex: number;
  totalSteps: number;
  action: string;
  status: "running" | "complete" | "error";
  message?: string;
}

export interface InstallProgress {
  phase: "starting" | "downloading" | "complete" | "error";
  message: string;
}

export interface CodegenProgress {
  phase: "starting" | "recording" | "complete" | "error";
  /** Absolute path of the recorded .spec.js (set on 'complete'). */
  outputPath?: string;
  message: string;
}
