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

// ── Green Metrics Tool submission ──────────────────────────────────────────
// co2-runner can hand a YAML journey to the Green Metrics Tool cluster (the
// same measurement backend webNRG / website-tester.green-coding.io uses) so a
// local Firefox-profiler reading can be put next to a RAPL reading taken on
// dedicated hardware. See runner/gmt.ts.

/** Metrics pulled from GMT's phase_stats for the journey phase. */
export interface GmtMetrics {
  /** GMT run UUID — the handle for the details / timeline pages. */
  runId: string;
  /** RAPL package energy for the journey phase. */
  cpuEnergyMWh: number | null;
  cpuPowerW: number | null;
  durationSeconds: number | null;
  networkTransferKb: number | null;
  networkCarbonG: number | null;
  carbonIntensityGCO2PerKWh: number | null;
  /** Link to the full run on metrics.green-coding.io. */
  detailsUrl: string;
}

export type GmtStatus = "pending" | "complete" | "error";

/** A journey handed to the GMT cluster, as persisted in the history DB. */
export interface GmtSubmission {
  /** Gateway job id — the handle we poll on until a run appears. */
  jobId: number;
  journeyName: string;
  /** The URL GMT opens before running the journey body. */
  page: string;
  submittedAt: string;
  status: GmtStatus;
  /** mWh from the most recent local run of the same journey, if any. */
  localMWh: number | null;
  metrics: GmtMetrics | null;
  error: string | null;
}

/** Live status of a submission, streamed to the UI over SSE. */
export interface GmtProgress {
  jobId: number;
  journeyName: string;
  /** The URL the cluster opens — shown on the card while it is still pending. */
  page?: string;
  status: GmtStatus;
  message: string;
  /** How long we have been waiting on the cluster, in seconds. */
  waitedSeconds?: number;
  metrics?: GmtMetrics;
  localMWh?: number | null;
}
