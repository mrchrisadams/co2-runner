// runner/gmt-jobs.ts — lifecycle of a journey handed to the GMT cluster.
//
// runner/gmt.ts speaks the protocol; this module owns what happens around it:
// persisting the job id before the wait begins, broadcasting status to the UI,
// and resuming jobs that were still pending when the process last exited.
//
// A cluster measurement takes 5–30 minutes and the gateway job id is the only
// handle on it, so the id is written to the history DB *before* we start
// waiting. Without that, closing the app would lose the run entirely.

import {
  awaitMetrics,
  type GmtDeps,
  type GmtScript,
  jobDetailsUrl,
  loadJourneyForGmt,
  submitToGateway,
} from "./gmt.ts";
import type { History } from "../ui/history.ts";
import type { GmtMetrics, GmtProgress, GmtSubmission } from "../types.ts";

/**
 * The slice of ResultsStore this module needs. Declared structurally so the
 * CLI can pass a plain printer instead of standing up a store, and so tests
 * can pass a recorder. ResultsStore satisfies it as-is.
 */
export interface GmtProgressSink {
  gmtProgress(p: GmtProgress): void;
}

export interface SubmitOptions {
  journeyPath: string;
  /** Name shown in the UI; defaults to the journey's own `name:` field. */
  displayName?: string;
  email?: string;
  history: History;
  store?: GmtProgressSink;
  deps?: GmtDeps;
}

export interface SubmitOutcome {
  /** The persisted row — pass straight to watchSubmission() to wait on it. */
  submission: GmtSubmission;
  script: GmtScript;
  /** Where the user can watch the run on webNRG. */
  jobUrl: string;
}

/** Outcome of waiting on a submission. A failed cluster run is a result, not
 * an exception, so both arms are ordinary return values. */
export type WatchOutcome =
  | { ok: true; metrics: GmtMetrics }
  | { ok: false; error: string };

/**
 * Converts a YAML journey, submits it, and persists the resulting job id.
 *
 * Does NOT wait for the measurement — call watchSubmission() (or the CLI's
 * blocking path) for that. Throws if the journey cannot be converted or the
 * gateway rejects it, in which case nothing is persisted.
 */
export async function submitJourney(
  opts: SubmitOptions,
): Promise<SubmitOutcome> {
  const { config, script } = await loadJourneyForGmt(opts.journeyPath);
  const journeyName = opts.displayName ?? config.name;

  const jobId = await submitToGateway({
    page: script.page,
    script: script.script,
    email: opts.email,
  }, opts.deps);

  // Pair the cluster figure with whatever we last measured locally, so the UI
  // can show them side by side even if the local run happened days ago.
  const localMWh = opts.history.latestByName(config.name)?.mWh ?? null;

  const submission: GmtSubmission = {
    jobId,
    journeyName,
    page: script.page,
    submittedAt: new Date().toISOString(),
    status: "pending",
    localMWh,
    metrics: null,
    error: null,
  };
  opts.history.insertGmtSubmission(submission);

  opts.store?.gmtProgress({
    jobId,
    journeyName,
    page: script.page,
    status: "pending",
    message:
      `Submitted to the GMT cluster (job ${jobId}). Results usually take 5–30 minutes.`,
    waitedSeconds: 0,
    localMWh,
  });

  return { submission, script, jobUrl: jobDetailsUrl(jobId) };
}

/**
 * Waits on a persisted submission and records its outcome.
 *
 * Resolves (rather than rejecting) on measurement failure — a cluster run that
 * fails is a recorded result, not an exception for the caller to handle.
 */
export async function watchSubmission(
  submission: GmtSubmission,
  history: History,
  store?: GmtProgressSink,
  deps?: GmtDeps,
): Promise<WatchOutcome> {
  const { jobId, journeyName, localMWh, page } = submission;
  try {
    const metrics = await awaitMetrics(
      jobId,
      journeyName,
      (p) => store?.gmtProgress({ ...p, page, localMWh }),
      { startedAtMs: Date.parse(submission.submittedAt) || undefined },
      deps,
    );
    history.completeGmtSubmission(jobId, { metrics });
    store?.gmtProgress({
      jobId,
      journeyName,
      page,
      status: "complete",
      message: "Cluster measurement complete",
      metrics,
      localMWh,
    });
    return { ok: true, metrics };
  } catch (err) {
    const message = (err as Error).message;
    history.completeGmtSubmission(jobId, { error: message });
    store?.gmtProgress({
      jobId,
      journeyName,
      page,
      status: "error",
      message,
      localMWh,
    });
    return { ok: false, error: message };
  }
}

/**
 * Picks up submissions left pending by a previous process.
 *
 * Each resumed poll carries its original submitted-at timestamp, so a job that
 * has already outlived the polling budget resolves on the first check instead
 * of waiting another 90 minutes.
 */
export function resumePendingSubmissions(
  history: History,
  store?: GmtProgressSink,
  deps?: GmtDeps,
): GmtSubmission[] {
  const pending = history.pendingGmtSubmissions();
  for (const submission of pending) {
    watchSubmission(submission, history, store, deps).catch((err) => {
      console.warn(
        `GMT job ${submission.jobId}: resume failed — ${
          (err as Error).message
        }`,
      );
    });
  }
  return pending;
}
