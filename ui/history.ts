// ui/history.ts — persistent run history using node:sqlite.
// Avoids Deno KV (stuck in beta since May 2025). Uses DatabaseSync which
// is built into Deno 2.2+ with no extra deps.

import { DatabaseSync } from "sqlite";
import type { JourneyResult } from "../types.ts";

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

  close(): void {
    this.db.close();
  }
}
