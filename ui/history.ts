// ui/history.ts — persistent run history using node:sqlite.
// Avoids Deno KV (stuck in beta since May 2025). Uses DatabaseSync which
// is built into Deno 2.2+ with no extra deps.

import { DatabaseSync } from "sqlite";
import type {
  GmtMetrics,
  GmtStatus,
  GmtSubmission,
  JourneyResult,
} from "../types.ts";

export interface StoredRun {
  id: number;
  name: string;
  mWh: number;
  joules: number;
  timestamp: string;
  profile: string | null;
}

export class History {
  private db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Ensure parent directory exists (SQLite will not create it).
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir) {
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist or the path may be relative; ignore.
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        name      TEXT NOT NULL,
        mWh       REAL NOT NULL,
        joules    REAL NOT NULL,
        timestamp TEXT NOT NULL,
        profile   TEXT
      );
    `);
    // Journeys handed to the Green Metrics Tool cluster. Kept in its own
    // table because a cluster run is an async handle (a gateway job id we
    // poll on), not a finished measurement — rows start out 'pending' and
    // are filled in minutes to hours later, possibly after a restart.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gmt_submissions (
        job_id       INTEGER PRIMARY KEY,
        journey_name TEXT NOT NULL,
        page         TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        status       TEXT NOT NULL,
        local_mWh    REAL,
        metrics      TEXT,
        error        TEXT
      );
    `);
  }

  insert(result: JourneyResult): void {
    const stmt = this.db.prepare(
      `INSERT INTO runs (name, mWh, joules, timestamp, profile)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(
      result.name,
      result.mWh,
      result.joules,
      result.timestamp,
      result.profilePath ?? null,
    );
  }

  recent(limit = 50): StoredRun[] {
    const stmt = this.db.prepare(
      `SELECT id, name, mWh, joules, timestamp, profile FROM runs
       ORDER BY id DESC LIMIT ?`,
    );
    return stmt.all(limit) as StoredRun[];
  }

  /** Most recent local run of a journey, by name. Used to pair a cluster
   * result with the local figure it should be shown next to. */
  latestByName(name: string): StoredRun | null {
    const stmt = this.db.prepare(
      `SELECT id, name, mWh, joules, timestamp, profile FROM runs
       WHERE name = ? ORDER BY id DESC LIMIT 1`,
    );
    return (stmt.get(name) as StoredRun | undefined) ?? null;
  }

  // ── GMT cluster submissions ────────────────────────────────────────────

  insertGmtSubmission(s: GmtSubmission): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO gmt_submissions
         (job_id, journey_name, page, submitted_at, status, local_mWh, metrics, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      s.jobId,
      s.journeyName,
      s.page,
      s.submittedAt,
      s.status,
      s.localMWh,
      s.metrics == null ? null : JSON.stringify(s.metrics),
      s.error,
    );
  }

  /** Records the outcome of a submission we were polling on. */
  completeGmtSubmission(
    jobId: number,
    outcome: { metrics: GmtMetrics } | { error: string },
  ): void {
    const done = "metrics" in outcome;
    const stmt = this.db.prepare(
      `UPDATE gmt_submissions SET status = ?, metrics = ?, error = ?
       WHERE job_id = ?`,
    );
    stmt.run(
      done ? "complete" : "error",
      done ? JSON.stringify(outcome.metrics) : null,
      done ? null : outcome.error,
      jobId,
    );
  }

  /** Submissions still waiting on the cluster — resumed on server startup. */
  pendingGmtSubmissions(): GmtSubmission[] {
    const stmt = this.db.prepare(
      `SELECT * FROM gmt_submissions WHERE status = 'pending'
       ORDER BY job_id ASC`,
    );
    return (stmt.all() as GmtSubmissionRow[]).map(rowToSubmission);
  }

  recentGmtSubmissions(limit = 20): GmtSubmission[] {
    const stmt = this.db.prepare(
      `SELECT * FROM gmt_submissions ORDER BY job_id DESC LIMIT ?`,
    );
    return (stmt.all(limit) as GmtSubmissionRow[]).map(rowToSubmission);
  }

  close(): void {
    this.db.close();
  }
}

interface GmtSubmissionRow {
  job_id: number;
  journey_name: string;
  page: string;
  submitted_at: string;
  status: string;
  local_mWh: number | null;
  metrics: string | null;
  error: string | null;
}

function rowToSubmission(row: GmtSubmissionRow): GmtSubmission {
  return {
    jobId: row.job_id,
    journeyName: row.journey_name,
    page: row.page,
    submittedAt: row.submitted_at,
    status: row.status as GmtStatus,
    localMWh: row.local_mWh,
    metrics: row.metrics == null ? null : JSON.parse(row.metrics) as GmtMetrics,
    error: row.error,
  };
}
