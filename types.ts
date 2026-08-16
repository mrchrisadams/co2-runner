// Shared types for co2-runner.

export interface JourneyConfig {
  name: string;
  url?: string;
  browser?: "firefox";
  headless?: boolean;
  steps: Step[];
}

export type Step =
  | { action: "goto"; url: string; waitFor?: string }
  | { action: "click"; selector: string; waitFor?: string }
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
