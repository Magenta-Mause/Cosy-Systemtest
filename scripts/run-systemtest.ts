/**
 * Systemtest runner.
 *
 * Runs the Playwright suite, parses the JSON report into one row per feature
 * (spec file), writes `results/summary.json`, prints a table, and pushes the
 * per-feature results to SigNoz as OTLP-HTTP metrics AND as one trace per run.
 *
 * Two signals, one push step, because they answer different questions: the metrics
 * are the time series the dashboard and the alert rules are built on ("has this
 * feature been red for two nights?"), the trace is the timeline of a single run
 * ("what ran when, how long did it take, which one failed and why"). The trace id
 * rides along as a resource attribute on the metrics, so the dashboard's run table
 * links straight into the run's trace.
 *
 * Three modes, because writing the summary and pushing it happen at different
 * points in the CI job:
 *   - (no flag)     run the suite, write the summary, push. Local default.
 *   - `--no-push`   run the suite and write the summary only.
 *   - `--push-only` push an existing `results/summary.json`; no Playwright.
 *
 * Two further flags exist for the PR gates (docs/pr-gate.md), which run this same
 * runner against a locally built PR image:
 *   - `--grep <pattern>`    forwarded to Playwright, so a gate can run just `@core`.
 *                           Rejected together with `--push-only`, where it would be
 *                           silently ignored.
 *   - `--fail-on-failure`   exit 1 when any feature failed — the deliberate opposite
 *                           of the "metrics are truth" default below. A gate has to
 *                           fail closed; the nightly must not.
 *
 * Why the split: `uninstall` is asserted by the workflow AFTER the suite step and
 * appended to `results/summary.json` as an extra feature row. Pushing from inside
 * the suite step therefore reported 19 of 20 features — a dashboard that silently
 * misrepresented the matrix. CI now runs `--no-push` for the suite and
 * `--push-only` in a later `if: always()` step, once that row exists.
 *
 * Semantics: "metrics are truth, exit 0". Test failures do NOT fail this process
 * — the per-feature results are the signal, and the dashboard/alerts decide what
 * is broken. (`--fail-on-failure` is the one, explicit opt-out; without it nothing
 * below changes.) The process exits non-zero ONLY on an infrastructure error:
 *   - Playwright could not produce a parseable report at all, or
 *   - `--push-only` found no usable `results/summary.json` to push, or
 *   - a telemetry push (metrics or trace) failed. A broken reporting path must not
 *     hide behind a green job; nobody notices a dashboard that silently stopped
 *     updating.
 * `results/summary.json` is written (and uploaded as an artifact) before any push
 * is attempted, so a failed push never costs us the results.
 *
 * The push is SKIPPED with an INFO log — and exit 0 — unless all three of
 * `OTEL_INGEST_URL`, `OTEL_INGEST_USER`, `OTEL_INGEST_PASSWORD` are set, so local
 * runs and forks (which have no ingest credentials) behave exactly as before.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.resolve('results');
const JSON_REPORT = path.join(RESULTS_DIR, 'playwright-report.json');
const SUMMARY = path.join(RESULTS_DIR, 'summary.json');

// ── OTLP push (metrics + trace) ──────────────────────────────────────────────
/** `service.name` resource attribute — the primary group-by in SigNoz. */
const SERVICE_NAME = 'cosy-systemtest';
/** Instrumentation scope the metrics and spans are reported under. */
const SCOPE_NAME = 'cosy-systemtest-runner';
/** OTLP-HTTP metrics path. The ingress matches it with `pathType: Exact`. */
const OTLP_METRICS_PATH = '/v1/metrics';
/** OTLP-HTTP traces path — allowed by the same ingress, also `pathType: Exact`. */
const OTLP_TRACES_PATH = '/v1/traces';
/** Base UI URL used to print a clickable deep link to the run's trace. */
const SIGNOZ_UI_URL = 'https://signoz.jannekeipert.de';
/**
 * Host serving the uploaded Playwright HTML reports (MinIO bucket
 * `cosy-systemtest-reports`, see the cluster-deployment repo). Overridable with
 * the `REPORTS_BASE_URL` env var / repo variable, exactly like `OTEL_INGEST_URL`.
 */
const DEFAULT_REPORTS_BASE_URL = 'https://systemtest-reports.jannekeipert.de';
const PUSH_TIMEOUT_MS = 15_000;
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_DELAY_MS = 3_000;
/** Cap on collector error text echoed into the log. */
const ERROR_BODY_CHARS = 500;

/**
 * Metric names. The `cosy_platform_` prefix is load-bearing, not verbosity: the
 * plain `cosy_systemtest_*` namespace is already used in the same SigNoz instance
 * by the *Cosy Domain Provider* systemtest (a different product, ingested via
 * Pushgateway → Prometheus remote_write), which has dashboards and alert rules on
 * those names. Sharing a name merges two products into one series, so a panel would
 * mix both and an alert would fire for the wrong one. `cosy_platform_` names this
 * repo's subject — the Cosy game-server platform. Do not shorten it; give any new
 * metric the same prefix.
 */
const METRIC = {
  featureStatus: 'cosy_platform_systemtest_feature_status',
  featureSkipped: 'cosy_platform_systemtest_feature_skipped',
  featureDuration: 'cosy_platform_systemtest_feature_duration_seconds',
  runSuccess: 'cosy_platform_systemtest_run_success',
  lastRunTimestamp: 'cosy_platform_systemtest_last_run_timestamp_seconds',
  runInfo: 'cosy_platform_systemtest_run_info',
} as const;

type FeatureStatus = 'passed' | 'failed' | 'skipped';

interface FeatureResult {
  feature: string;
  status: FeatureStatus;
  durationSeconds: number;
  /**
   * Wall-clock window the feature occupied, taken from the Playwright report's
   * per-result `startTime` + `duration`. Optional on purpose: the workflow appends
   * the `uninstall` row with `jq` and cannot know these, and an older summary has
   * neither. They exist so the trace can lay the run out on REAL time instead of a
   * reconstruction — see `planTimeline`.
   */
  startedAt?: string;
  endedAt?: string;
  /** First error message of a failed feature — the trace's span status message. */
  errorMessage?: string;
}

/**
 * Which build was under test. The CI workflow reads the effective image tags back
 * out of the installed `.env` and exports them; locally they are usually absent,
 * hence `null` rather than a guess.
 */
interface Versions {
  backend: string | null;
  frontend: string | null;
}

interface Summary {
  channel: string;
  versions: Versions;
  generatedAt: string;
  runUrl: string | null;
  /**
   * Public URL of this run's hosted Playwright HTML report (videos and traces
   * included). Derived, not observed — see `buildReportUrl`.
   */
  reportUrl: string | null;
  features: FeatureResult[];
}

// ── Minimal shape of the Playwright JSON report we rely on ───────────────────
interface PwError {
  message?: string;
}
interface PwTestResult {
  status?: string;
  duration?: number;
  /** ISO 8601, per JSONReportTestResult — the only real clock the run leaves behind. */
  startTime?: string;
  error?: PwError;
  errors?: PwError[];
}
interface PwTest {
  status?: string; // expected | unexpected | flaky | skipped
  results?: PwTestResult[];
}
interface PwSpec {
  title?: string;
  file?: string;
  tests?: PwTest[];
}
interface PwSuite {
  file?: string;
  suites?: PwSuite[];
  specs?: PwSpec[];
}
interface PwReport {
  suites?: PwSuite[];
}

/**
 * Playwright's own CLI entry point, run directly with `node` instead of through `npx`.
 *
 * Three reasons, in order of how much they hurt:
 *
 *  1. `spawnSync('npx', …)` without a shell fails with ENOENT on Windows, where the
 *     executable is `npx.cmd`. `npm run systemtest` therefore never worked there at
 *     all — it died with "Playwright produced no JSON report", which reads like a
 *     Playwright problem and is not one.
 *  2. The obvious repair, `shell: true`, trades that for a quoting bug: the argv is
 *     flattened into one `cmd.exe` string, so a `--grep` pattern containing `|` —
 *     `@core|@extended` is an ordinary Playwright tag expression — would be split as a
 *     shell pipe. Spawning a real executable keeps every argument a separate argv
 *     entry, which is what the `--grep` handling below relies on.
 *  3. It runs the `@playwright/test` pinned in this repo's lockfile rather than
 *     whatever `npx` decides to resolve (or fetch).
 *
 * `require.resolve` is available because this package is CommonJS ("type":
 * "commonjs"); `./cli` is a declared export of @playwright/test.
 */
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

function runPlaywright(grep?: string): number {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.rmSync(JSON_REPORT, { force: true });

  // Explicit reporter set so the runner behaves the same locally and in CI, and
  // always emits the JSON we parse. `github` adds inline annotations in CI.
  const reporters = ['list', 'html', 'json'];
  if (process.env.CI) reporters.push('github');

  const args = [PLAYWRIGHT_CLI, 'test', `--reporter=${reporters.join(',')}`];
  // `--grep` is passed as two argv entries, never interpolated into a shell string:
  // the pattern is a regex that routinely contains characters a shell would eat.
  if (grep) args.push('--grep', grep);

  const run = spawnSync(process.execPath, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: JSON_REPORT },
  });
  // status is the playwright exit code (non-zero when tests failed) — informational.
  return run.status ?? 1;
}

/** Flatten the report tree into (file, tests[]) pairs. */
function collectSpecs(report: PwReport): PwSpec[] {
  const out: PwSpec[] = [];
  const walk = (suite: PwSuite) => {
    for (const spec of suite.specs ?? []) out.push(spec);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

function featureName(file: string): string {
  return path.basename(file).replace(/\.spec\.ts$/, '');
}

/** Terminal escapes make Playwright's message unreadable inside a span attribute. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const ERROR_MESSAGE_CHARS = 300;

/** The headline of a Playwright failure: first line, no colour codes, bounded. */
function firstErrorMessage(test: PwTest): string | undefined {
  for (const result of test.results ?? []) {
    const raw = result.error?.message ?? result.errors?.[0]?.message;
    if (!raw) continue;
    const cleaned = raw.replace(ANSI_ESCAPE, '').trim().split('\n')[0].trim();
    if (cleaned) return cleaned.slice(0, ERROR_MESSAGE_CHARS);
  }
  return undefined;
}

interface FeatureAggregate {
  anyFailed: boolean;
  anyRan: boolean;
  durationMs: number;
  /** Earliest result start / latest result end across the file's tests, in epoch ms. */
  startMs?: number;
  endMs?: number;
  errorMessage?: string;
}

function parseReport(): FeatureResult[] {
  const report = JSON.parse(fs.readFileSync(JSON_REPORT, 'utf-8')) as PwReport;
  const specs = collectSpecs(report);

  const byFeature = new Map<string, FeatureAggregate>();

  for (const spec of specs) {
    const feature = featureName(spec.file ?? 'unknown');
    const agg = byFeature.get(feature) ?? { anyFailed: false, anyRan: false, durationMs: 0 };
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected') {
        agg.anyFailed = true;
        agg.errorMessage ??= firstErrorMessage(test);
      }
      if (test.status && test.status !== 'skipped') agg.anyRan = true;
      for (const r of test.results ?? []) {
        agg.durationMs += r.duration ?? 0;
        // A retried test contributes several results; the feature's window spans
        // all of them, so take the outermost bounds rather than the first result.
        const startMs = r.startTime ? Date.parse(r.startTime) : NaN;
        if (Number.isNaN(startMs)) continue;
        const endMs = startMs + (r.duration ?? 0);
        agg.startMs = agg.startMs === undefined ? startMs : Math.min(agg.startMs, startMs);
        agg.endMs = agg.endMs === undefined ? endMs : Math.max(agg.endMs, endMs);
      }
    }
    byFeature.set(feature, agg);
  }

  const results: FeatureResult[] = [];
  for (const [feature, agg] of byFeature) {
    const status: FeatureStatus = agg.anyFailed ? 'failed' : agg.anyRan ? 'passed' : 'skipped';
    results.push({
      feature,
      status,
      durationSeconds: round1(agg.durationMs / 1000),
      ...(agg.startMs !== undefined && agg.endMs !== undefined
        ? {
            startedAt: new Date(agg.startMs).toISOString(),
            endedAt: new Date(agg.endMs).toISOString(),
          }
        : {}),
      ...(agg.errorMessage ? { errorMessage: agg.errorMessage } : {}),
    });
  }
  return results.sort((a, b) => a.feature.localeCompare(b.feature));
}

/** Empty strings count as absent — an unset CI env var arrives as `''`, not undefined. */
function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function writeSummary(features: FeatureResult[]): Summary {
  // `staging` when the workflow pinned an image tag, `release` otherwise.
  const channel = optionalEnv('COSY_CHANNEL') ?? 'release';
  const summary: Summary = {
    channel,
    versions: {
      backend: optionalEnv('COSY_BACKEND_TAG'),
      frontend: optionalEnv('COSY_FRONTEND_TAG'),
    },
    generatedAt: new Date().toISOString(),
    runUrl: buildRunUrl(),
    reportUrl: buildReportUrl(channel),
    features,
  };
  fs.writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const FEATURE_STATUSES: readonly string[] = ['passed', 'failed', 'skipped'];

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) throw new Error(`${what}.${key} is missing or empty`);
  return value;
}

/** A missing/`null` optional string stays `null`; anything else is a malformed file. */
function optionalString(record: Record<string, unknown>, key: string, what: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${what}.${key} is not a string`);
  return value;
}

/**
 * An optional ISO timestamp. Absent is fine (the `uninstall` row and pre-timeline
 * summaries have none — the trace falls back to a derived window); present but
 * unparseable is a malformed file and must not become a nonsense span.
 */
function optionalTimestamp(
  record: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = optionalString(record, key, what);
  if (value === null) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${what}.${key} is not a parseable timestamp: "${value}"`);
  }
  return value;
}

function parseFeature(value: unknown, index: number): FeatureResult {
  const what = `features[${index}]`;
  const record = asRecord(value, what);
  const status = requireString(record, 'status', what);
  if (!FEATURE_STATUSES.includes(status)) {
    throw new Error(`${what}.status is "${status}", expected one of ${FEATURE_STATUSES.join('/')}`);
  }
  const durationSeconds = record.durationSeconds;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)) {
    throw new Error(`${what}.durationSeconds is missing or not a finite number`);
  }
  const errorMessage = optionalString(record, 'errorMessage', what);
  return {
    feature: requireString(record, 'feature', what),
    status: status as FeatureStatus,
    durationSeconds,
    startedAt: optionalTimestamp(record, 'startedAt', what),
    endedAt: optionalTimestamp(record, 'endedAt', what),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

/**
 * Read and validate an existing `results/summary.json` (the only input `--push-only`
 * has). Validated rather than trusted because the workflow edits the file with `jq`
 * after the runner wrote it: a bad row must fail here, loudly, instead of turning
 * into a payload the collector rejects — silently, from the job's point of view.
 */
function readSummary(): Summary {
  const root = asRecord(JSON.parse(fs.readFileSync(SUMMARY, 'utf-8')), 'summary');
  const generatedAt = requireString(root, 'generatedAt', 'summary');
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`summary.generatedAt is not a parseable timestamp: "${generatedAt}"`);
  }
  if (!Array.isArray(root.features)) throw new Error('summary.features is missing or not an array');
  const versions = root.versions === undefined ? {} : asRecord(root.versions, 'summary.versions');

  return {
    channel: requireString(root, 'channel', 'summary'),
    versions: {
      backend: optionalString(versions, 'backend', 'summary.versions'),
      frontend: optionalString(versions, 'frontend', 'summary.versions'),
    },
    generatedAt,
    runUrl: optionalString(root, 'runUrl', 'summary'),
    reportUrl: optionalString(root, 'reportUrl', 'summary'),
    features: root.features.map(parseFeature),
  };
}

function printTable(summary: Summary): void {
  const icon = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' } as const;
  console.log(`\n=== Cosy systemtest results (channel: ${summary.channel}) ===`);
  console.log(
    `  backend: ${summary.versions.backend ?? 'unknown'}  ` +
      `frontend: ${summary.versions.frontend ?? 'unknown'}`,
  );
  for (const f of summary.features) {
    console.log(`  ${icon[f.status]}  ${f.feature.padEnd(20)} ${f.durationSeconds}s`);
  }
  const failed = summary.features.filter((f) => f.status === 'failed').length;
  console.log(`  ---\n  ${summary.features.length} features, ${failed} failed`);
}

// ── OTLP-HTTP/JSON encoding ──────────────────────────────────────────────────
// Hand-built to avoid pulling the OTel SDK into a repo that otherwise only needs
// Playwright. Three encoding rules from the proto3 JSON mapping matter, and getting
// any of them wrong is how a payload gets a 200 and is then silently dropped:
//   - int64/fixed64 fields (`timeUnixNano`, `asInt`, `startTimeUnixNano`,
//     `endTimeUnixNano`, an attribute's `intValue`) are DECIMAL STRINGS;
//   - `asDouble` / `doubleValue` are plain JSON numbers;
//   - trace and span ids are LOWERCASE HEX of the raw bytes — 32 chars (16 bytes)
//     and 16 chars (8 bytes). Any other length is rejected or, worse, orphaned.

type OtlpAnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number };

interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}
interface OtlpNumberDataPoint {
  attributes: OtlpAttribute[];
  timeUnixNano: string;
  asInt?: string;
  asDouble?: number;
}
interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  gauge: { dataPoints: OtlpNumberDataPoint[] };
}
interface OtlpPayload {
  resourceMetrics: {
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: { scope: { name: string }; metrics: OtlpMetric[] }[];
  }[];
}

/** `SPAN_KIND_INTERNAL` — nothing here is a client/server call. */
const SPAN_KIND_INTERNAL = 1;
/** `Status.StatusCode`: UNSET is "no claim made", which is what a skip is. */
const SPAN_STATUS = { unset: 0, ok: 1, error: 2 } as const;

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}
interface OtlpTracePayload {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
}

/** Response shape we care about: a 2xx can still report dropped points/spans. */
interface OtlpResponse {
  partialSuccess?: {
    rejectedDataPoints?: string | number;
    rejectedSpans?: string | number;
    errorMessage?: string;
  };
}

function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/**
 * ISO 8601 UTC, second precision — `2026-07-25T15:42:15Z`.
 *
 * The width and the zone are load-bearing, not cosmetic: the dashboard's run table
 * SORTS on this string, and a lexicographic sort equals a chronological one only
 * while every value has the same shape and the same zone. Milliseconds (variable in
 * some producers) or a local offset would break that quietly — the rows would still
 * render, just in the wrong order.
 */
function isoSeconds(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}

function doubleAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: value } };
}

function gauge(
  name: string,
  description: string,
  unit: string,
  dataPoints: OtlpNumberDataPoint[],
): OtlpMetric {
  return { name, description, unit, gauge: { dataPoints } };
}

/**
 * Attributes that describe WHAT was tested and WHICH run produced it.
 *
 * TRACES ONLY. These belong on the trace, where per-run identity IS the point: a
 * trace is one run by definition, so run-varying labels cost nothing there.
 *
 * They must NOT go on the metrics' resource. Every one of `trace_id`, `run_at`,
 * `run_url`, `report_url` (and `image_tag` on a release boundary) takes a new value
 * per run, and SigNoz materialises resource attributes as series labels — so each run
 * would land on its OWN series. That breaks every cross-run query:
 *   - `last_over_time(...[26h])` returns one sample PER RUN instead of the latest
 *     run's, so the dashboard's count tiles read feature × run (32 "failing" for
 *     ~5 red features over 6 runs);
 *   - `count_over_time(...) >= 2` can never be satisfied — one run writes exactly one
 *     sample per series — so `CosySystemtestFeatureFailing` could never fire at all.
 * The run-level labels live on {@link METRIC.runInfo} instead, which is what the
 * dashboard's run table groups by. See CLAUDE.md conventions 11 and 13.
 */
function traceResourceAttributes(summary: Summary, traceId: string): OtlpAttribute[] {
  const attributes = [
    attribute('service.name', SERVICE_NAME),
    // House convention is a prod/staging split via `deployment.environment`; here
    // the channel IS the environment (`release` = the published product).
    attribute('deployment.environment', summary.channel),
    attribute('cosy.backend.image_tag', summary.versions.backend ?? 'unknown'),
    attribute('cosy.frontend.image_tag', summary.versions.frontend ?? 'unknown'),
    attribute('cosy.systemtest.trace_id', traceId),
    // WHEN the run reported, as a fixed-width ISO 8601 UTC string. This is
    // `summary.generatedAt` — the moment the summary was written, right after the
    // suite — not the moment the suite started. It is the run table's timestamp
    // column AND its sort key: an ISO 8601 UTC string sorts lexicographically in
    // exactly chronological order, which the previous sort (on the GitHub run URL)
    // only did by accident of run ids being equal-width and monotonic.
    attribute('cosy.systemtest.run_at', isoSeconds(Date.parse(summary.generatedAt))),
  ];
  // Absent outside GitHub Actions — omit rather than invent a placeholder link.
  if (summary.runUrl) attributes.push(attribute('cosy.systemtest.run_url', summary.runUrl));
  // One click from a red cell to the video of what happened. Same cardinality
  // profile as the run URL (one new value per run), and the dashboard's run table
  // shows it as its own column.
  if (summary.reportUrl) attributes.push(attribute('cosy.systemtest.report_url', summary.reportUrl));
  return attributes;
}

/**
 * Resource attributes for the METRICS — deliberately only the ones that are stable
 * across runs, so successive runs append to the SAME series per (feature, channel)
 * and `last_over_time` genuinely means "the latest run". Anything run-varying goes on
 * {@link METRIC.runInfo} as a data-point attribute instead.
 */
function metricsResourceAttributes(summary: Summary): OtlpAttribute[] {
  return [
    attribute('service.name', SERVICE_NAME),
    // House convention is a prod/staging split via `deployment.environment`; here
    // the channel IS the environment (`release` = the published product). Stable per
    // channel, so it does not fragment the series.
    attribute('deployment.environment', summary.channel),
  ];
}

/**
 * Build the OTLP payload for one run.
 *
 * How `skipped` is represented — deliberately, because reporting a skip as a pass
 * would be a lie and reporting it as a failure would page for a feature nobody
 * tested: a skipped feature is **omitted** from `feature_status` and from
 * `feature_duration_seconds` (a 0 there would read as "it got fast"), and is
 * instead flagged by `feature_skipped` = 1. Every feature reports
 * `feature_skipped` (0 when it ran), so the series never disappears and "this
 * feature stopped running" is itself alertable.
 */
export function buildMetricsPayload(summary: Summary, traceId: string): OtlpPayload {
  // Milliseconds × 1e6 exceeds Number.MAX_SAFE_INTEGER — must go through BigInt.
  const observedAtMs = Date.parse(summary.generatedAt);
  const timeUnixNano = (BigInt(observedAtMs) * 1_000_000n).toString();

  const channelAttributes = [attribute('channel', summary.channel)];
  const featureAttributes = (feature: string): OtlpAttribute[] => [
    attribute('feature', feature),
    ...channelAttributes,
  ];
  /**
   * The run's identity, as DATA-POINT attributes on `run_info` only. Deliberately
   * kept off every per-feature metric: these take a new value per run, and a
   * run-varying label makes each run its own series, which is exactly what stops
   * `last_over_time` from meaning "the latest run".
   */
  const runAttributes: OtlpAttribute[] = [
    ...channelAttributes,
    attribute('cosy.backend.image_tag', summary.versions.backend ?? 'unknown'),
    attribute('cosy.frontend.image_tag', summary.versions.frontend ?? 'unknown'),
    attribute('cosy.systemtest.trace_id', traceId),
    // Fixed-width ISO 8601 UTC: the run table's timestamp column AND its sort key,
    // because such a string sorts lexicographically in exactly chronological order.
    attribute('cosy.systemtest.run_at', isoSeconds(Date.parse(summary.generatedAt))),
  ];
  // Absent outside GitHub Actions — omit rather than invent a placeholder link.
  if (summary.runUrl) {
    runAttributes.push(attribute('cosy.systemtest.run_url', summary.runUrl));
  }
  if (summary.reportUrl) {
    runAttributes.push(attribute('cosy.systemtest.report_url', summary.reportUrl));
  }
  // The pull request a `channel=pr` run gated. A run-level dimension, so it belongs
  // here and nowhere else (convention 11) — and without it a row in the PR table is
  // just a GitHub run id nobody can place. Absent for the nightly, which has no PR.
  const prUrl = optionalEnv('COSY_PR_URL');
  if (prUrl) {
    runAttributes.push(attribute('cosy.systemtest.pr_url', prUrl));
  }

  const executed = summary.features.filter((f) => f.status !== 'skipped');
  const anyFailed = summary.features.some((f) => f.status === 'failed');

  const metrics: OtlpMetric[] = [
    gauge(
      METRIC.featureStatus,
      '1 = feature passed, 0 = feature failed. Skipped features are absent by ' +
        'design — see cosy_platform_systemtest_feature_skipped.',
      '1',
      executed.map((f) => ({
        attributes: featureAttributes(f.feature),
        timeUnixNano,
        asInt: f.status === 'passed' ? '1' : '0',
      })),
    ),
    gauge(
      METRIC.featureSkipped,
      '1 = feature did not run in this run, 0 = it ran (passed or failed).',
      '1',
      summary.features.map((f) => ({
        attributes: featureAttributes(f.feature),
        timeUnixNano,
        asInt: f.status === 'skipped' ? '1' : '0',
      })),
    ),
    gauge(
      METRIC.featureDuration,
      'Wall-clock seconds the feature spent running. Skipped features are absent.',
      's',
      executed.map((f) => ({
        attributes: featureAttributes(f.feature),
        timeUnixNano,
        asDouble: f.durationSeconds,
      })),
    ),
    gauge(
      METRIC.runSuccess,
      '1 = no feature failed in this run, 0 = at least one did. Skips do not count ' +
        'as failures — pair with cosy_platform_systemtest_feature_skipped.',
      '1',
      [{ attributes: channelAttributes, timeUnixNano, asInt: anyFailed ? '0' : '1' }],
    ),
    gauge(
      METRIC.lastRunTimestamp,
      'Unix time the run finished — the staleness signal for the nightly.',
      's',
      [{ attributes: channelAttributes, timeUnixNano, asDouble: Math.floor(observedAtMs / 1000) }],
    ),
    gauge(
      METRIC.runInfo,
      'Always 1. Carries the run-level labels (image tags, run/report URL, trace id, ' +
        'run timestamp) that must NOT sit on the per-feature metrics, where they would ' +
        'give every run its own series. This is what the dashboard run table groups by.',
      '1',
      [{ attributes: runAttributes, timeUnixNano, asInt: '1' }],
    ),
  ];

  return {
    resourceMetrics: [
      {
        resource: { attributes: metricsResourceAttributes(summary) },
        // A metric with no data points carries no information; drop it (happens
        // when literally every feature skipped, e.g. a local run with no install).
        scopeMetrics: [
          {
            scope: { name: SCOPE_NAME },
            metrics: metrics.filter((m) => m.gauge.dataPoints.length > 0),
          },
        ],
      },
    ],
  };
}

// ── Trace: one run = one trace, one feature = one span ───────────────────────

/**
 * OTLP ids are raw bytes rendered as lowercase hex: 16 bytes (32 chars) for a trace,
 * 8 bytes (16 chars) for a span. `crypto.randomBytes` rather than `Math.random`,
 * which is neither uniform nor collision-safe at these widths and would eventually
 * merge two runs into one trace.
 */
function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

function toUnixNano(epochMs: number): string {
  // Milliseconds × 1e6 exceeds Number.MAX_SAFE_INTEGER — must go through BigInt.
  return (BigInt(Math.round(epochMs)) * 1_000_000n).toString();
}

/** Where one feature sits on the run's timeline, and whether that is measured. */
interface FeatureWindow {
  feature: FeatureResult;
  startMs: number;
  endMs: number;
  /** true = real Playwright clock; false = reconstructed, see `planTimeline`. */
  measured: boolean;
}

function measuredWindow(feature: FeatureResult): { startMs: number; endMs: number } | null {
  if (!feature.startedAt || !feature.endedAt) return null;
  const startMs = Date.parse(feature.startedAt);
  const endMs = Date.parse(feature.endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  // A window that ends before it starts is nonsense; clamp instead of emitting a
  // negative-duration span, which renders as garbage in the trace view.
  return { startMs, endMs: Math.max(startMs, endMs) };
}

function durationMs(feature: FeatureResult): number {
  return feature.status === 'skipped' ? 0 : Math.max(0, Math.round(feature.durationSeconds * 1000));
}

/**
 * Place every feature on a timeline.
 *
 * Rows that carry `startedAt`/`endedAt` — every spec row, since the runner copies
 * them out of the Playwright report — are placed on the REAL clock; nothing about
 * their position is invented.
 *
 * Rows without them are reconstructed and marked `cosy.systemtest.timing=derived`
 * on the span, so nobody reads a made-up position as a measurement. In practice
 * that is exactly one row, `uninstall`, which the workflow appends after the suite:
 * it is laid out sequentially starting at the last measured end, which is truthful
 * (it really does run after the suite) even though its exact start is not recorded.
 * If NOTHING is measured (a pre-timeline summary), the whole run is laid out back to
 * back ending at `generatedAt` — the suite runs serially in CI (`workers: 1`), so a
 * sequential layout is the honest reconstruction, but it is still a reconstruction.
 */
function planTimeline(summary: Summary): FeatureWindow[] {
  const measured = summary.features.map((feature) => ({
    feature,
    window: measuredWindow(feature),
  }));
  const measuredEnds = measured
    .map((m) => m.window?.endMs)
    .filter((end): end is number => end !== undefined);
  const derivedTotalMs = measured
    .filter((m) => !m.window)
    .reduce((sum, m) => sum + durationMs(m.feature), 0);

  let cursor =
    measuredEnds.length > 0
      ? Math.max(...measuredEnds)
      : Date.parse(summary.generatedAt) - derivedTotalMs;

  return measured.map(({ feature, window }) => {
    if (window) return { feature, ...window, measured: true };
    const startMs = cursor;
    cursor = startMs + durationMs(feature);
    return { feature, startMs, endMs: cursor, measured: false };
  });
}

/**
 * Span name for a feature. A skipped feature gets a `[skipped]` suffix on purpose:
 * its span is zero-length, and a zero-length span with a green (or no) status is
 * exactly the thing that could be misread as "it ran and was fast". The suffix
 * makes the skip readable in the trace's span list without opening the span, and
 * `feature`/`status` attributes stay clean for filtering.
 */
function spanName(feature: FeatureResult): string {
  return feature.status === 'skipped' ? `${feature.feature} [skipped]` : feature.feature;
}

/**
 * Span status, mirroring the metric convention "never report a skip as a pass":
 *   - failed  → ERROR with the Playwright message (or a generic one for rows the
 *               workflow appended, which carry no message).
 *   - passed  → OK.
 *   - skipped → UNSET. Not OK: nothing was verified, so no claim is made.
 */
function spanStatus(feature: FeatureResult): { code: number; message?: string } {
  if (feature.status === 'failed') {
    return {
      code: SPAN_STATUS.error,
      message: feature.errorMessage ?? `feature "${feature.feature}" failed`,
    };
  }
  return { code: feature.status === 'passed' ? SPAN_STATUS.ok : SPAN_STATUS.unset };
}

/**
 * Build the trace for one run: a root span covering the whole run, one child span
 * per feature. The trace answers what the metrics cannot — the ORDER and the shape
 * of a single run: which feature ran when, how long each took, which failed and with
 * what message.
 */
export function buildTracePayload(summary: Summary, traceId: string): OtlpTracePayload {
  const generatedAtMs = Date.parse(summary.generatedAt);
  const windows = planTimeline(summary);
  const rootSpanId = newSpanId();

  const featureSpans: OtlpSpan[] = windows.map(({ feature, startMs, endMs, measured }) => ({
    traceId,
    spanId: newSpanId(),
    parentSpanId: rootSpanId,
    name: spanName(feature),
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(startMs),
    endTimeUnixNano: toUnixNano(endMs),
    attributes: [
      attribute('feature', feature.feature),
      attribute('channel', summary.channel),
      attribute('status', feature.status),
      // The number the metric reports, so a span can be reconciled with the
      // dashboard: for a retried feature it is the SUM of the attempts and thus
      // smaller than the span's wall clock.
      doubleAttribute('cosy.systemtest.duration_seconds', feature.durationSeconds),
      attribute('cosy.systemtest.timing', measured ? 'measured' : 'derived'),
    ],
    status: spanStatus(feature),
  }));

  const counts = {
    total: summary.features.length,
    passed: summary.features.filter((f) => f.status === 'passed').length,
    failed: summary.features.filter((f) => f.status === 'failed').length,
    skipped: summary.features.filter((f) => f.status === 'skipped').length,
  };

  // The run spans everything it contains; with no features at all (an empty
  // summary) it collapses onto `generatedAt` rather than inventing a window.
  const rootStartMs =
    windows.length > 0 ? Math.min(...windows.map((w) => w.startMs)) : generatedAtMs;
  const rootEndMs = windows.length > 0 ? Math.max(...windows.map((w) => w.endMs)) : generatedAtMs;

  const rootSpan: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    // The channel is in the NAME (not just an attribute) because SigNoz's trace
    // list shows the root span name: `release` vs `staging` is then readable
    // without opening the trace. Two values only — no cardinality problem.
    name: `cosy-systemtest run (${summary.channel})`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(rootStartMs),
    endTimeUnixNano: toUnixNano(rootEndMs),
    attributes: [
      attribute('channel', summary.channel),
      intAttribute('cosy.systemtest.features.total', counts.total),
      intAttribute('cosy.systemtest.features.passed', counts.passed),
      intAttribute('cosy.systemtest.features.failed', counts.failed),
      intAttribute('cosy.systemtest.features.skipped', counts.skipped),
    ],
    status:
      counts.failed > 0
        ? {
            code: SPAN_STATUS.error,
            message: `${counts.failed} of ${counts.total} features failed: ${summary.features
              .filter((f) => f.status === 'failed')
              .map((f) => f.feature)
              .join(', ')}`,
          }
        : { code: SPAN_STATUS.ok },
  };

  return {
    resourceSpans: [
      {
        // Deliberately RICHER than the metrics' resource (see
        // `metricsResourceAttributes`): a trace is one run by definition, so per-run
        // identity costs nothing here. `service.name` is shared, which is what lets
        // SigNoz relate the two signals.
        resource: { attributes: traceResourceAttributes(summary, traceId) },
        scopeSpans: [{ scope: { name: SCOPE_NAME }, spans: [rootSpan, ...featureSpans] }],
      },
    ],
  };
}

/** Distinguishes "retry might help" (5xx, timeout) from "it won't" (401, bad payload). */
class PushError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

/**
 * A 2xx is not proof the data landed: OTLP reports dropped items in
 * `partialSuccess` — `rejectedDataPoints` for metrics, `rejectedSpans` for traces.
 * Treat any rejection as a failed push — otherwise a malformed payload no-ops in
 * silence, which is the exact failure mode this whole reporting path exists to
 * avoid.
 */
function assertNothingRejected(responseBody: string, itemNoun: string): void {
  if (!responseBody.trim()) return;
  let parsed: OtlpResponse;
  try {
    parsed = JSON.parse(responseBody) as OtlpResponse;
  } catch {
    return; // Not JSON, so nothing to assert — the 2xx stands.
  }
  const rejected =
    Number(parsed.partialSuccess?.rejectedDataPoints ?? 0) +
    Number(parsed.partialSuccess?.rejectedSpans ?? 0);
  if (rejected > 0) {
    throw new PushError(
      `collector accepted the request but rejected ${rejected} ${itemNoun}: ` +
        `${parsed.partialSuccess?.errorMessage || '(no error message)'}`,
      false,
    );
  }
}

async function postOtlp(
  endpoint: string,
  basicAuth: string,
  body: string,
  itemNoun: string,
): Promise<void> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${basicAuth}` },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    // 4xx is a wrong credential or a bad payload — a retry changes nothing.
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new PushError(
      `HTTP ${response.status} ${response.statusText} — ${text.slice(0, ERROR_BODY_CHARS)}`,
      retryable,
    );
  }
  assertNothingRejected(text, itemNoun);
}

/** One OTLP signal, ready to POST. */
interface OtlpSignal {
  /** OTLP-HTTP path, e.g. `/v1/metrics`. */
  path: string;
  /** What the payload carries, for logs and rejection messages ("spans", …). */
  itemNoun: string;
  body: string;
  items: number;
}

/** Push one signal, retrying only what a retry can fix. */
async function pushSignal(signal: OtlpSignal, ingestUrl: string, basicAuth: string): Promise<void> {
  const endpoint = `${ingestUrl}${signal.path}`;
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      await postOtlp(endpoint, basicAuth, signal.body, signal.itemNoun);
      console.log(`Pushed ${signal.items} ${signal.itemNoun} to ${endpoint} (attempt ${attempt}).`);
      return;
    } catch (err) {
      lastError = describeError(err);
      const retryable = !(err instanceof PushError) || err.retryable;
      if (!retryable || attempt === PUSH_ATTEMPTS) break;
      console.error(
        `OTLP push attempt ${attempt}/${PUSH_ATTEMPTS} to ${endpoint} failed: ${lastError} — ` +
          `retrying in ${PUSH_RETRY_DELAY_MS} ms.`,
      );
      await sleep(PUSH_RETRY_DELAY_MS);
    }
  }
  throw new Error(`OTLP push to ${endpoint} failed: ${lastError}`);
}

function countDataPoints(payload: OtlpPayload): number {
  return payload.resourceMetrics[0].scopeMetrics[0].metrics.reduce(
    (sum, metric) => sum + metric.gauge.dataPoints.length,
    0,
  );
}

type PushOutcome = 'pushed' | 'skipped';

/**
 * Push this run's telemetry to SigNoz over authenticated OTLP-HTTP: the metrics
 * (the dashboard's and the alerts' time series) and the trace (this run's timeline).
 *
 * Returns `'skipped'` (no credentials configured — local/fork runs) or `'pushed'`.
 * Throws on a genuine push failure; the caller turns that into a non-zero exit.
 *
 * Both signals are attempted even if the first one fails, and the errors are
 * reported together: half the picture is better than none, and a failure in either
 * still fails the job.
 */
export async function pushTelemetry(summary: Summary): Promise<PushOutcome> {
  const ingestUrl = optionalEnv('OTEL_INGEST_URL');
  const user = optionalEnv('OTEL_INGEST_USER');
  const password = optionalEnv('OTEL_INGEST_PASSWORD');

  if (!ingestUrl || !user || !password) {
    console.log(
      '\nINFO: OTLP push skipped — OTEL_INGEST_URL, OTEL_INGEST_USER and OTEL_INGEST_PASSWORD ' +
        'are not all set. results/summary.json holds the full result. This is the expected ' +
        'behaviour for local runs and forks; CI sets all three.',
    );
    return 'skipped';
  }

  // One id for both signals: the metrics carry it as a resource attribute so the
  // dashboard can link into the trace it identifies.
  const traceId = newTraceId();
  const metricsPayload = buildMetricsPayload(summary, traceId);
  const tracePayload = buildTracePayload(summary, traceId);
  const signals: OtlpSignal[] = [
    {
      path: OTLP_METRICS_PATH,
      itemNoun: 'data points',
      body: JSON.stringify(metricsPayload),
      items: countDataPoints(metricsPayload),
    },
    {
      path: OTLP_TRACES_PATH,
      itemNoun: 'spans',
      body: JSON.stringify(tracePayload),
      items: tracePayload.resourceSpans[0].scopeSpans[0].spans.length,
    },
  ];

  // Never build the credentials into a shell string or log them; only the
  // endpoint is ever printed.
  const basicAuth = Buffer.from(`${user}:${password}`).toString('base64');
  const base = ingestUrl.replace(/\/+$/, '');

  console.log(`\nTrace id for this run: ${traceId}`);
  console.log(`Trace in SigNoz: ${SIGNOZ_UI_URL}/trace/${traceId}`);
  if (summary.reportUrl) console.log(`Playwright report: ${summary.reportUrl}`);

  const failures: string[] = [];
  for (const signal of signals) {
    try {
      await pushSignal(signal, base, basicAuth);
    } catch (err) {
      failures.push(describeError(err));
    }
  }
  if (failures.length > 0) throw new Error(failures.join(' | '));
  return 'pushed';
}

/**
 * `fetch` rejects with a bare "fetch failed" — the reason an operator actually
 * needs (ECONNREFUSED, DNS failure, TLS error) sits on `cause`.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { cause } = err;
  return cause instanceof Error && cause.message && cause.message !== err.message
    ? `${err.message} (${cause.message})`
    : err.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const USAGE =
  'usage: run-systemtest.ts [--no-push | --push-only] [--grep <pattern>] [--fail-on-failure]';

interface Options {
  /** Run Playwright and write the summary (false only for `--push-only`). */
  runTests: boolean;
  /** Attempt the OTLP push (false only for `--no-push`). */
  push: boolean;
  /** Playwright `--grep` tag expression, e.g. `@core`. Undefined runs the whole suite. */
  grep?: string;
  /** Exit non-zero when any feature failed — opts OUT of "metrics are truth". */
  failOnFailure: boolean;
}

function parseOptions(argv: string[]): Options {
  const flags = argv.slice(2);
  let pushOnly = false;
  let noPush = false;
  let grep: string | undefined;
  let failOnFailure = false;

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--push-only') {
      pushOnly = true;
    } else if (flag === '--no-push') {
      noPush = true;
    } else if (flag === '--fail-on-failure') {
      failOnFailure = true;
    } else if (flag === '--grep' || flag.startsWith('--grep=')) {
      const value = flag.startsWith('--grep=') ? flag.slice('--grep='.length) : flags[++i];
      // An empty pattern would match everything, silently turning a `@core` gate into
      // the full suite. Refuse rather than run the wrong thing for 40 minutes.
      if (!value) {
        console.error(`--grep requires a non-empty pattern.\n${USAGE}`);
        process.exit(2);
      }
      grep = value;
    } else {
      console.error(`Unknown argument(s): ${flag}\n${USAGE}`);
      process.exit(2);
    }
  }

  if (pushOnly && noPush) {
    console.error(`--push-only and --no-push are mutually exclusive.\n${USAGE}`);
    process.exit(2);
  }
  // `--push-only` runs no Playwright, so a `--grep` there would be silently ignored —
  // and "my gate ran the wrong subset and nobody noticed" is precisely the class of
  // bug this flag exists to avoid. Make it a hard error instead.
  if (pushOnly && grep) {
    console.error(`--grep has no effect with --push-only (no suite runs).\n${USAGE}`);
    process.exit(2);
  }

  return { runTests: !pushOnly, push: !noPush, grep, failOnFailure };
}

/** Run the suite and write `results/summary.json` — the artifact-bearing half. */
function runSuiteAndWriteSummary(grep?: string): Summary {
  const pwExit = runPlaywright(grep);

  if (!fs.existsSync(JSON_REPORT)) {
    console.error(
      `Infrastructure error: Playwright produced no JSON report at ${JSON_REPORT} ` +
        `(exit ${pwExit}). Failing the runner so the workflow surfaces it.`,
    );
    process.exit(1);
  }

  let features: FeatureResult[];
  try {
    features = parseReport();
  } catch (err) {
    console.error(
      `Infrastructure error: could not parse ${JSON_REPORT}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  // Written unconditionally — red features are a normal outcome, and the summary
  // is what the artifact and the later push step both read.
  const summary = writeSummary(features);
  printTable(summary);
  console.log(`\nWrote ${path.relative(process.cwd(), SUMMARY)}.`);
  return summary;
}

/**
 * `--push-only`: the summary another step already wrote is the whole input.
 *
 * A missing or unusable file is an infrastructure error, not a quiet no-op: this
 * step exists so the run reaches the dashboard, and a run that reports nothing must
 * not look healthy. (It is reached with `if: always()`, so it also fires when the
 * suite step died before writing anything — that job is already red, and this makes
 * the reporting gap explicit rather than adding a second silent failure.)
 */
function loadSummaryForPush(): Summary {
  const relative = path.relative(process.cwd(), SUMMARY);
  if (!fs.existsSync(SUMMARY)) {
    console.error(
      `::error::--push-only: ${relative} does not exist, so this run reports NOTHING to ` +
        `SigNoz. The suite step must have failed before writing it — check the earlier steps.`,
    );
    process.exit(1);
  }
  try {
    const summary = readSummary();
    console.log(
      `Read ${relative}: ${summary.features.length} features, channel ${summary.channel}, ` +
        `generated ${summary.generatedAt}.`,
    );
    return summary;
  } catch (err) {
    console.error(
      `::error::--push-only: ${relative} is not a usable summary — ` +
        `${err instanceof Error ? err.message : err}. Refusing to push a payload the ` +
        `collector would reject.`,
    );
    process.exit(1);
  }
}

/**
 * The single exit point for a run that got as far as producing a summary.
 *
 * Default (`--fail-on-failure` absent) is convention 8: metrics are truth, red
 * features exit 0, and only infrastructure errors are non-zero. The nightly relies on
 * that — a red feature must still reach the dashboard rather than killing the job
 * before the push step.
 *
 * `--fail-on-failure` opts out, for the PR gates. It is a flag rather than a `--mode
 * release|pr` string on purpose: a mistyped or defaulted mode string would silently
 * turn a blocking check into a no-op that looks perfectly healthy in the log, whereas
 * forgetting a flag can only produce a false GREEN in the one place we have a second,
 * independent check for it — the caller workflow's allowlist assertion over
 * `summary.json`, which is the authoritative gate. See docs/pr-gate.md.
 *
 * Note what this does NOT catch, deliberately: a feature that fails and then passes on
 * retry is Playwright `flaky`, which `parseReport` records as `passed`. PR runs set
 * `SYSTEMTEST_RETRIES=1`, so the gate tolerates exactly one flake per test by design —
 * a 30-minute gate that reds on a single transient blip gets switched off. A feature
 * that is *skipped* is likewise not a failure here; the caller's allowlist is what
 * turns "all six specs skipped because the install died" into a red.
 */
function exitWithVerdict(summary: Summary, options: Options): never {
  if (!options.failOnFailure) {
    console.log('Exiting 0 regardless of feature outcomes (metrics are truth).');
    process.exit(0);
  }

  const failed = summary.features.filter((f) => f.status === 'failed');
  if (failed.length === 0) {
    console.log(
      `--fail-on-failure: no feature failed (${summary.features.length} recorded). Exiting 0.`,
    );
    process.exit(0);
  }

  console.error(
    `::error::--fail-on-failure: ${failed.length} feature(s) FAILED — ` +
      `${failed.map((f) => f.feature).join(', ')}. This is a product failure, not an ` +
      `infrastructure one: open the Playwright report artifact for the video and trace.`,
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv);
  const summary = options.runTests
    ? runSuiteAndWriteSummary(options.grep)
    : loadSummaryForPush();

  if (!options.push) {
    console.log(
      '\nINFO: --no-push — results written, nothing pushed (no metrics, no trace). In CI the ' +
        'push runs in a later step, after the workflow appended the `uninstall` row; see ' +
        '.github/workflows/systemtest.yml. (PR gate runs never push at all — docs/pr-gate.md.)',
    );
    exitWithVerdict(summary, options);
  }

  try {
    await pushTelemetry(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `::error::Systemtest telemetry push FAILED — the SigNoz dashboard will go stale ` +
        `for this run. ${message}`,
    );
    console.error(
      'The test results themselves are intact in results/summary.json (uploaded as an ' +
        'artifact). This is a REPORTING/infrastructure failure, not a product failure — ' +
        'failing the job so a silently broken reporting path cannot go unnoticed.',
    );
    process.exit(1);
  }

  exitWithVerdict(summary, options);
}

function buildRunUrl(): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return null;
}

/**
 * Where this run's Playwright HTML report is served: one immutable prefix per
 * channel and GitHub run id in the `cosy-systemtest-reports` MinIO bucket.
 *
 *   https://systemtest-reports.jannekeipert.de/<channel>/<run-id>/index.html
 *
 * DERIVED, not observed. The workflow uploads the report in a separate step, and
 * this URL is computed from values we already have — so the link is identical
 * whichever step computes it, and the same run id already inside
 * `cosy.systemtest.run_url` reproduces it by hand. The cost of deriving is that a
 * failed upload leaves a 404 behind (the upload step warns loudly when that
 * happens); the alternative, threading a value between two workflow steps, would
 * silently drop the link whenever the ordering changed.
 *
 * `/index.html` is part of the URL on purpose: MinIO serves objects, not
 * directories, so the bare prefix has nothing to return.
 *
 * A re-run of the same GitHub run overwrites the prefix rather than adding an
 * `attempt-N` segment — `run_url` has no attempt component either, so an
 * attempt-scoped path could not be derived from what the metrics carry, and both
 * signals then agree on describing the latest attempt.
 */
function buildReportUrl(channel: string): string | null {
  const runId = optionalEnv('GITHUB_RUN_ID');
  if (!runId) return null; // Not on GitHub Actions — nothing is uploaded either.
  // Deriving a URL for a run that publishes no report would put a permanent 404 on
  // the dashboard, which is worse than no link: it looks like a broken upload rather
  // than a deliberate choice. PR gate runs set this to `false` — they keep their
  // report as a GitHub artifact and never touch the public bucket (docs/pr-gate.md).
  if (optionalEnv('SYSTEMTEST_REPORT_PUBLISHED') === 'false') return null;
  const base = (optionalEnv('REPORTS_BASE_URL') ?? DEFAULT_REPORTS_BASE_URL).replace(/\/+$/, '');
  return `${base}/${channel}/${runId}/index.html`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

main().catch((err) => {
  console.error(
    `::error::Infrastructure error in the systemtest runner: ` +
      `${err instanceof Error ? (err.stack ?? err.message) : err}`,
  );
  process.exit(1);
});
