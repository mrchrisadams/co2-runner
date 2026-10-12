import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GmtProgressSink,
  resumePendingSubmissions,
  submitJourney,
  watchSubmission,
} from "../../runner/gmt-jobs.ts";
import { GMT_PHASE } from "../../runner/gmt.ts";
import { History } from "../../ui/history.ts";
import type { GmtProgress, GmtSubmission, JourneyResult } from "../../types.ts";

const YAML_JOURNEY = `
name: "cluster journey"
url: "https://example.com/"
steps:
  - action: goto
    url: "https://example.com/"
  - action: wait
    ms: 2000
`;

async function withFixture(
  fn: (ctx: {
    history: History;
    journeyPath: string;
    dir: string;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "co2-runner-gmt-"));
  const history = new History(join(dir, "history.db"));
  const journeyPath = join(dir, "journey.yaml");
  await writeFile(journeyPath, YAML_JOURNEY);
  try {
    await fn({ history, journeyPath, dir });
  } finally {
    history.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Collects the progress events a submission emits. */
function recorder(): GmtProgressSink & { events: GmtProgress[] } {
  const events: GmtProgress[] = [];
  return { events, gmtProgress: (p) => events.push(p) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const runRow = (failed = false) => [
  "uuid-1",
  "name",
  "uri",
  "main",
  "2026-08-19T10:00:00Z",
  0,
  "file.yml",
  {},
  "machine",
  "commit",
  failed ? null : 1_700_000_000,
  failed,
  6,
  null,
];

const phaseStats = () => ({
  data: {
    data: {
      [GMT_PHASE]: {
        data: {
          cpu_energy_rapl_msr_component: {
            data: { Package_0: { data: { "uuid-1": { mean: 3_600_000 } } } },
          },
        },
      },
    },
  },
});

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return ((input: string | URL | Request) =>
    Promise.resolve(handler(String(input)))) as unknown as typeof fetch;
}

const happyPath = stubFetch((url) => {
  if (url.includes("/save")) return json({ data: { job_id: 99 } });
  if (url.includes("/v2/runs")) return json({ data: [runRow()] });
  return json(phaseStats());
});

// ── submitJourney ──────────────────────────────────────────────────────────

test("submitJourney persists the job id before any waiting happens", async () => {
  await withFixture(async ({ history, journeyPath }) => {
    const outcome = await submitJourney({
      journeyPath,
      history,
      deps: { fetchImpl: happyPath },
    });

    assert.equal(outcome.submission.jobId, 99);
    assert.equal(outcome.submission.page, "https://example.com/");

    // The id must be on disk immediately — a cluster run outlives the process
    // that started it, and the id is the only handle on it.
    const [stored] = history.pendingGmtSubmissions();
    assert.equal(stored.jobId, 99);
    assert.equal(stored.status, "pending");
    assert.equal(stored.journeyName, "cluster journey");
    assert.equal(stored.metrics, null);
  });
});

test("submitJourney pairs the submission with the last local run", async () => {
  await withFixture(async ({ history, journeyPath }) => {
    const local: JourneyResult = {
      name: "cluster journey",
      mWh: 1.75,
      joules: 6.3,
      timestamp: "2026-08-18T09:00:00Z",
      profilePath: "/tmp/p.json",
    };
    history.insert(local);

    const outcome = await submitJourney({
      journeyPath,
      history,
      deps: { fetchImpl: happyPath },
    });
    assert.equal(outcome.submission.localMWh, 1.75);
    assert.equal(history.pendingGmtSubmissions()[0].localMWh, 1.75);
  });
});

test("submitJourney leaves localMWh null when the journey was never run locally", async () => {
  await withFixture(async ({ history, journeyPath }) => {
    const outcome = await submitJourney({
      journeyPath,
      history,
      deps: { fetchImpl: happyPath },
    });
    assert.equal(outcome.submission.localMWh, null);
  });
});

test("submitJourney announces the submission with its target URL", async () => {
  await withFixture(async ({ history, journeyPath }) => {
    const store = recorder();
    await submitJourney({
      journeyPath,
      history,
      store,
      deps: { fetchImpl: happyPath },
    });
    assert.equal(store.events.length, 1);
    assert.equal(store.events[0].status, "pending");
    assert.equal(store.events[0].page, "https://example.com/");
    assert.ok(store.events[0].message.includes("job 99"));
  });
});

test("submitJourney persists nothing when the gateway rejects the journey", async () => {
  await withFixture(async ({ history, journeyPath }) => {
    await assert.rejects(
      () =>
        submitJourney({
          journeyPath,
          history,
          deps: {
            fetchImpl: stubFetch(() => new Response("nope", { status: 500 })),
          },
        }),
      /HTTP 500/,
    );
    assert.equal(history.pendingGmtSubmissions().length, 0);
  });
});

test("submitJourney refuses a codegen script journey", async () => {
  await withFixture(async ({ history, dir }) => {
    const scriptPath = join(dir, "journey.spec.js");
    await writeFile(scriptPath, "test('x', async () => {});");
    await assert.rejects(
      () => submitJourney({ journeyPath: scriptPath, history }),
      /only YAML journeys/,
    );
  });
});

// ── watchSubmission ────────────────────────────────────────────────────────

const pending = (over: Partial<GmtSubmission> = {}): GmtSubmission => ({
  jobId: 99,
  journeyName: "cluster journey",
  page: "https://example.com/",
  submittedAt: new Date().toISOString(),
  status: "pending",
  localMWh: null,
  metrics: null,
  error: null,
  ...over,
});

test("watchSubmission records metrics and flips the row to complete", async () => {
  await withFixture(async ({ history }) => {
    history.insertGmtSubmission(pending());
    const store = recorder();

    const outcome = await watchSubmission(pending(), history, store, {
      fetchImpl: happyPath,
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.metrics.cpuEnergyMWh, 1);
    assert.equal(history.pendingGmtSubmissions().length, 0);
    const [stored] = history.recentGmtSubmissions();
    assert.equal(stored.status, "complete");
    assert.equal(stored.metrics?.cpuEnergyMWh, 1);
    assert.equal(store.events.at(-1)?.status, "complete");
  });
});

test("watchSubmission records a failed cluster run without throwing", async () => {
  await withFixture(async ({ history }) => {
    history.insertGmtSubmission(pending());
    const store = recorder();

    const outcome = await watchSubmission(pending(), history, store, {
      fetchImpl: stubFetch((url) =>
        url.includes("/v2/runs")
          ? json({ data: [runRow(true)] })
          : json(phaseStats())
      ),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok && outcome.error.includes("could not measure"));
    const [stored] = history.recentGmtSubmissions();
    assert.equal(stored.status, "error");
    assert.ok((stored.error ?? "").includes("could not measure"));
    assert.equal(store.events.at(-1)?.status, "error");
  });
});

test("watchSubmission carries the page URL onto every progress event", async () => {
  await withFixture(async ({ history }) => {
    history.insertGmtSubmission(pending());
    const store = recorder();
    await watchSubmission(pending(), history, store, {
      fetchImpl: happyPath,
      sleepImpl: () => Promise.resolve(),
    });
    for (const ev of store.events) {
      assert.equal(ev.page, "https://example.com/");
    }
  });
});

// ── resumePendingSubmissions ───────────────────────────────────────────────

test("resumePendingSubmissions picks up rows left pending by a previous process", async () => {
  await withFixture(async ({ history }) => {
    history.insertGmtSubmission(pending({ jobId: 1 }));
    history.insertGmtSubmission(pending({ jobId: 2 }));
    history.insertGmtSubmission(pending({ jobId: 3, status: "complete" }));

    const resumed = resumePendingSubmissions(history, undefined, {
      fetchImpl: happyPath,
      sleepImpl: () => Promise.resolve(),
    });

    assert.deepEqual(resumed.map((s) => s.jobId), [1, 2]);
    // watchSubmission runs detached; give the microtask queue a turn.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(history.pendingGmtSubmissions().length, 0);
  });
});

test("resumePendingSubmissions ages out a job that outlived the poll budget", async () => {
  // A stale row must not restart its 90-minute budget on every server start.
  await withFixture(async ({ history }) => {
    const old = pending({
      jobId: 7,
      submittedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    });
    history.insertGmtSubmission(old);

    resumePendingSubmissions(history, undefined, {
      fetchImpl: stubFetch(() => new Response(null, { status: 204 })),
      sleepImpl: () => Promise.resolve(),
    });
    await new Promise((r) => setTimeout(r, 10));

    const [stored] = history.recentGmtSubmissions();
    assert.equal(stored.status, "error");
    assert.ok((stored.error ?? "").includes("still queued"));
  });
});
