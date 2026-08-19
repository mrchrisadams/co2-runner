# ADR-006: Submitting journeys to the Green Metrics Tool cluster

**Status:** Accepted

## Context

co2-runner measures energy on the machine it runs on: Playwright's Firefox is
driven through a journey and the Mozilla Profiler's power counters are summed.
That number is real, but it is a number about _this laptop_ — its CPU, its
thermal state, whatever else was running at the time. It answers "did my change
make my site cheaper on my machine", not "how does this site compare to others"
or "has it drifted over the last six months".

Green Coding Solutions already runs the other half of that picture: the Green
Metrics Tool (GMT) cluster, which measures RAPL package energy on dedicated
hardware, and their webNRG frontend (<https://website-tester.green-coding.io>)
which lets anyone submit a URL and a Playwright snippet to it. The submission
path is three unauthenticated HTTP calls and the code for it is readable in the
webNRG repo.

So the question was not whether to build a measurement backend — it was whether
to reach the existing one, and on what terms.

## Decision

Add a **cluster submission** path alongside the local one. A YAML journey is
translated into the bare Playwright body GMT expects, POSTed to
`gateway.green-coding.io/save` in `website-script` mode, and the resulting job
is polled until metrics come back.

The specifics that carried weight:

**Only YAML journeys, for now.** GMT wants a bare statement body which it
base64-decodes and `eval`s inside a closure where `page`, `context`, `browser`
and `sleep` are globals. Our YAML step list maps onto that almost one-to-one —
six actions, one or two lines each. Codegen `.spec.js` journeys do not: they
would need their `test()` callback brace-matched out, their `import` stripped,
and their `expect()` calls detected (GMT has no `expect`, so an assertion would
fail as a cryptic runtime error mid-measurement). That is a separate piece of
work with its own failure modes, and shipping it half-done would mean silently
broken cluster runs. `.spec.js` submissions are rejected with a clear message.

**Deterministic translation.** `executeStep()` randomises human-like scrolling
(`rand(120, 240)` px chunks, `rand(40, 180)` ms pauses) to look less robotic.
The cluster builds a _timeline_ from repeated submissions of the same journey,
so a body that serialises differently every time would put dice rolls into the
graph. The generated script uses the midpoints — 180 px, 110 ms — and is
asserted to be byte-identical across calls.

**The leading `goto` is kept.** GMT's template already opens the page in an
earlier hidden phase, so re-navigating in the measured phase is redundant work.
We keep it anyway: a local run includes the initial page load in its figure, and
dropping it here would compare a load-plus-interactions number against an
interactions-only one. GMT's copy of that load comes off a warm cache, so it is
still cheaper than ours — one of several reasons the two figures are indicative
rather than equal.

**The job id is persisted before we start waiting.** A cluster measurement takes
5–30 minutes and the gateway job id is the only handle on it. Writing it to
`gmt_submissions` before the first poll means closing the app does not lose the
run; the server picks pending rows back up on startup. Each resumed poll carries
its original `submitted_at`, so a stale job ages out on the first check instead
of being granted a fresh 90-minute budget on every restart.

**Journey length is reported, not enforced.** An earlier version of this feature
refused journeys estimated over 60 seconds, because `lib/scenario_runner.py`
hardcoded a 60-second wait on the Playwright IPC ready signal — and since
co2-runner submits a whole journey as a single `gmtRunScriptB64()` command, that
60 seconds bounded the entire journey rather than one step. GMT has since
changed that wait to follow `--measurement-flow-process-duration` (24 h by
default), so the ceiling is gone and the check with it. The translation step
still estimates a journey's length and shows it in the submission preview, so
the user knows how much cluster time they are asking for — but nothing is
rejected on length.

(Worth knowing if this resurfaces: the `timeout: 5000` in
`templates/partials/gmt-playwright-ipc.js`'s `contextOptions` is inert.
Playwright has no `timeout` option on `newContext()` and silently ignores it, so
the per-action timeout there is Playwright's 30-second default, not 5 seconds.
Changing it requires `context.setDefaultTimeout()`.)

**Explicit consent, every time.** This is the only part of co2-runner that talks
to a third party. Until now the server bound to loopback and made no outbound
calls beyond the Playwright download. Submission sends the target URL, the
generated script and (optionally) an email to `gateway.green-coding.io`, and the
run is publicly listed on `metrics.green-coding.io`. So `/gmt-preview` renders
the exact payload — target URL, full script, estimated duration — in a modal
with that warning before `/gmt-submit` is reachable at all. Nothing auto-submits
after a local run.

## Consequences

The two figures shown side by side are **not a before/after**, and every surface
that shows them says so. Local sums the whole Firefox process on the user's
desktop across the entire journey; the cluster reports RAPL package energy for
the journey phase only, in a container with a warm cache and a Squid proxy in
front. They are each meaningful against their own history and misleading against
each other. We deliberately do not compute a delta or a ratio between them.

Script-mode runs are not deduplicated the way plain URL submissions are (the
gateway skips a URL measured in the last 30 days), so every submission costs
real cluster time. This is a reason to keep submission an explicit click rather
than something that happens on every local run.

co2-runner now depends on three green-coding.io endpoints staying shape-stable:
the gateway's `/save` response, `/v2/runs`' column order, and the metric names
inside `/v1/phase_stats/single`. The column indices in particular are positional
and undocumented. They are read in exactly one place (`runner/gmt.ts`) with the
GMT `SELECT` referenced in a comment, and the parsing is covered by fixture
tests, so a shape change surfaces as a test failure rather than a wrong number.

## Alternatives considered

**Running GMT locally.** GMT can be self-hosted, and the repo is right there.
But it wants Docker, a Postgres instance and root-level access to RAPL — an
enormous ask for a tool whose whole pitch is "download one binary". It also
would not give the cross-site comparison, which comes from everyone's runs
landing in the same public database on the same hardware.

**Linking out to webNRG instead of integrating.** Cheap, but it drops the
journey: the user would re-enter the URL and hand-write the Playwright snippet
that co2-runner already knows how to generate. The translation layer is the
actual value here.
