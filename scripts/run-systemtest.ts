/**
 * Systemtest runner.
 *
 * Runs the Playwright suite, parses the JSON report into one row per feature
 * (spec file), writes `results/summary.json`, prints a table, and pushes the
 * per-feature results to SigNoz as OTLP-HTTP metrics.
 *
 * Three modes, because writing the summary and pushing it happen at different
 * points in the CI job:
 *   - (no flag)     run the suite, write the summary, push. Local default.
 *   - `--no-push`   run the suite and write the summary only.
 *   - `--push-only` push an existing `results/summary.json`; no Playwright.
 *
 * Why the split: `uninstall` is asserted by the workflow AFTER the suite step and
 * appended to `results/summary.json` as an extra feature row. Pushing from inside
 * the suite step therefore reported 19 of 20 features — a dashboard that silently
 * misrepresented the matrix. CI now runs `--no-push` for the suite and
 * `--push-only` in a later `if: always()` step, once that row exists.
 *
 * Semantics: "metrics are truth, exit 0". Test failures do NOT fail this process
 * — the per-feature results are the signal, and the dashboard/alerts decide what
 * is broken. The process exits non-zero ONLY on an infrastructure error:
 *   - Playwright could not produce a parseable report at all, or
 *   - `--push-only` found no usable `results/summary.json` to push, or
 *   - the metric push failed. A broken reporting path must not hide behind a
 *     green job; nobody notices a dashboard that silently stopped updating.
 * `results/summary.json` is written (and uploaded as an artifact) before any push
 * is attempted, so a failed push never costs us the results.
 *
 * The push is SKIPPED with an INFO log — and exit 0 — unless all three of
 * `OTEL_INGEST_URL`, `OTEL_INGEST_USER`, `OTEL_INGEST_PASSWORD` are set, so local
 * runs and forks (which have no ingest credentials) behave exactly as before.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.resolve('results');
const JSON_REPORT = path.join(RESULTS_DIR, 'playwright-report.json');
const SUMMARY = path.join(RESULTS_DIR, 'summary.json');

// ── OTLP metric push ─────────────────────────────────────────────────────────
/** `service.name` resource attribute — the primary group-by in SigNoz. */
const SERVICE_NAME = 'cosy-systemtest';
/** Instrumentation scope the metrics are reported under. */
const SCOPE_NAME = 'cosy-systemtest-runner';
/** OTLP-HTTP metrics path. The ingress matches it with `pathType: Exact`. */
const OTLP_METRICS_PATH = '/v1/metrics';
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
} as const;

type FeatureStatus = 'passed' | 'failed' | 'skipped';

interface FeatureResult {
  feature: string;
  status: FeatureStatus;
  durationSeconds: number;
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
  features: FeatureResult[];
}

// ── Minimal shape of the Playwright JSON report we rely on ───────────────────
interface PwTestResult {
  status?: string;
  duration?: number;
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

function runPlaywright(): number {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.rmSync(JSON_REPORT, { force: true });

  // Explicit reporter set so the runner behaves the same locally and in CI, and
  // always emits the JSON we parse. `github` adds inline annotations in CI.
  const reporters = ['list', 'html', 'json'];
  if (process.env.CI) reporters.push('github');

  const run = spawnSync('npx', ['playwright', 'test', `--reporter=${reporters.join(',')}`], {
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

function parseReport(): FeatureResult[] {
  const report = JSON.parse(fs.readFileSync(JSON_REPORT, 'utf-8')) as PwReport;
  const specs = collectSpecs(report);

  const byFeature = new Map<string, { anyFailed: boolean; anyRan: boolean; durationMs: number }>();

  for (const spec of specs) {
    const feature = featureName(spec.file ?? 'unknown');
    const agg = byFeature.get(feature) ?? { anyFailed: false, anyRan: false, durationMs: 0 };
    for (const test of spec.tests ?? []) {
      if (test.status === 'unexpected') agg.anyFailed = true;
      if (test.status && test.status !== 'skipped') agg.anyRan = true;
      for (const r of test.results ?? []) agg.durationMs += r.duration ?? 0;
    }
    byFeature.set(feature, agg);
  }

  const results: FeatureResult[] = [];
  for (const [feature, agg] of byFeature) {
    const status: FeatureStatus = agg.anyFailed ? 'failed' : agg.anyRan ? 'passed' : 'skipped';
    results.push({ feature, status, durationSeconds: round1(agg.durationMs / 1000) });
  }
  return results.sort((a, b) => a.feature.localeCompare(b.feature));
}

/** Empty strings count as absent — an unset CI env var arrives as `''`, not undefined. */
function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function writeSummary(features: FeatureResult[]): Summary {
  const summary: Summary = {
    // `staging` when the workflow pinned an image tag, `release` otherwise.
    channel: optionalEnv('COSY_CHANNEL') ?? 'release',
    versions: {
      backend: optionalEnv('COSY_BACKEND_TAG'),
      frontend: optionalEnv('COSY_FRONTEND_TAG'),
    },
    generatedAt: new Date().toISOString(),
    runUrl: buildRunUrl(),
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
  return {
    feature: requireString(record, 'feature', what),
    status: status as FeatureStatus,
    durationSeconds,
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
// Playwright. Two encoding rules from the proto3 JSON mapping matter, and getting
// either wrong is how a payload gets a 200 and is then silently dropped:
//   - int64/fixed64 fields (`timeUnixNano`, `asInt`) are DECIMAL STRINGS;
//   - `asDouble` is a plain JSON number.

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
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

/** Response shape we care about: a 2xx can still report dropped points. */
interface OtlpResponse {
  partialSuccess?: { rejectedDataPoints?: string | number; errorMessage?: string };
}

function attribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
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
 * Attributes that describe WHAT was tested, not which feature — so every data
 * point is attributable to a build and to the run that produced it (see the
 * "a result must be attributable to a build" convention in CLAUDE.md).
 * Image tags and run URL change per run, so each run adds one series per metric;
 * at one nightly run that is a bounded, deliberate cost.
 */
function resourceAttributes(summary: Summary): OtlpAttribute[] {
  const attributes = [
    attribute('service.name', SERVICE_NAME),
    // House convention is a prod/staging split via `deployment.environment`; here
    // the channel IS the environment (`release` = the published product).
    attribute('deployment.environment', summary.channel),
    attribute('cosy.backend.image_tag', summary.versions.backend ?? 'unknown'),
    attribute('cosy.frontend.image_tag', summary.versions.frontend ?? 'unknown'),
  ];
  // Absent outside GitHub Actions — omit rather than invent a placeholder link.
  if (summary.runUrl) attributes.push(attribute('cosy.systemtest.run_url', summary.runUrl));
  return attributes;
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
export function buildMetricsPayload(summary: Summary): OtlpPayload {
  // Milliseconds × 1e6 exceeds Number.MAX_SAFE_INTEGER — must go through BigInt.
  const observedAtMs = Date.parse(summary.generatedAt);
  const timeUnixNano = (BigInt(observedAtMs) * 1_000_000n).toString();

  const channelAttributes = [attribute('channel', summary.channel)];
  const featureAttributes = (feature: string): OtlpAttribute[] => [
    attribute('feature', feature),
    ...channelAttributes,
  ];
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
  ];

  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(summary) },
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
 * A 2xx is not proof the data landed: OTLP reports dropped points in
 * `partialSuccess.rejectedDataPoints`. Treat any rejection as a failed push —
 * otherwise a malformed payload no-ops in silence, which is the exact failure
 * mode this whole reporting path exists to avoid.
 */
function assertNothingRejected(responseBody: string): void {
  if (!responseBody.trim()) return;
  let parsed: OtlpResponse;
  try {
    parsed = JSON.parse(responseBody) as OtlpResponse;
  } catch {
    return; // Not JSON, so nothing to assert — the 2xx stands.
  }
  const rejected = Number(parsed.partialSuccess?.rejectedDataPoints ?? 0);
  if (rejected > 0) {
    throw new PushError(
      `collector accepted the request but rejected ${rejected} data points: ` +
        `${parsed.partialSuccess?.errorMessage || '(no error message)'}`,
      false,
    );
  }
}

async function postOtlp(endpoint: string, basicAuth: string, body: string): Promise<void> {
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
  assertNothingRejected(text);
}

type PushOutcome = 'pushed' | 'skipped';

/**
 * Push the per-feature results to SigNoz over authenticated OTLP-HTTP.
 *
 * Returns `'skipped'` (no credentials configured — local/fork runs) or `'pushed'`.
 * Throws on a genuine push failure; the caller turns that into a non-zero exit.
 */
export async function pushMetrics(summary: Summary): Promise<PushOutcome> {
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

  const endpoint = `${ingestUrl.replace(/\/+$/, '')}${OTLP_METRICS_PATH}`;
  const payload = buildMetricsPayload(summary);
  const body = JSON.stringify(payload);
  const dataPoints = payload.resourceMetrics[0].scopeMetrics[0].metrics.reduce(
    (sum, metric) => sum + metric.gauge.dataPoints.length,
    0,
  );
  // Never build the credentials into a shell string or log them; only the
  // endpoint is ever printed.
  const basicAuth = Buffer.from(`${user}:${password}`).toString('base64');

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      await postOtlp(endpoint, basicAuth, body);
      console.log(`\nPushed ${dataPoints} data points to ${endpoint} (attempt ${attempt}).`);
      return 'pushed';
    } catch (err) {
      lastError = describeError(err);
      const retryable = !(err instanceof PushError) || err.retryable;
      if (!retryable || attempt === PUSH_ATTEMPTS) break;
      console.error(
        `OTLP push attempt ${attempt}/${PUSH_ATTEMPTS} failed: ${lastError} — ` +
          `retrying in ${PUSH_RETRY_DELAY_MS} ms.`,
      );
      await sleep(PUSH_RETRY_DELAY_MS);
    }
  }
  throw new Error(`OTLP push to ${endpoint} failed: ${lastError}`);
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

const USAGE = 'usage: run-systemtest.ts [--no-push | --push-only]';

interface Options {
  /** Run Playwright and write the summary (false only for `--push-only`). */
  runTests: boolean;
  /** Attempt the OTLP push (false only for `--no-push`). */
  push: boolean;
}

function parseOptions(argv: string[]): Options {
  const flags = argv.slice(2);
  const unknown = flags.filter((flag) => flag !== '--no-push' && flag !== '--push-only');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(', ')}\n${USAGE}`);
    process.exit(2);
  }
  const pushOnly = flags.includes('--push-only');
  const noPush = flags.includes('--no-push');
  if (pushOnly && noPush) {
    console.error(`--push-only and --no-push are mutually exclusive.\n${USAGE}`);
    process.exit(2);
  }
  return { runTests: !pushOnly, push: !noPush };
}

/** Run the suite and write `results/summary.json` — the artifact-bearing half. */
function runSuiteAndWriteSummary(): Summary {
  const pwExit = runPlaywright();

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

async function main(): Promise<void> {
  const options = parseOptions(process.argv);
  const summary = options.runTests ? runSuiteAndWriteSummary() : loadSummaryForPush();

  if (!options.push) {
    console.log(
      '\nINFO: --no-push — results written, metrics NOT pushed. In CI the push runs in a ' +
        'later step, after the workflow appended the `uninstall` row; see ' +
        '.github/workflows/systemtest.yml.',
    );
    process.exit(0);
  }

  try {
    await pushMetrics(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `::error::Systemtest metric push FAILED — the SigNoz dashboard will go stale ` +
        `for this run. ${message}`,
    );
    console.error(
      'The test results themselves are intact in results/summary.json (uploaded as an ' +
        'artifact). This is a REPORTING/infrastructure failure, not a product failure — ' +
        'failing the job so a silently broken reporting path cannot go unnoticed.',
    );
    process.exit(1);
  }

  // Metrics-are-truth: never fail the process on red features.
  console.log('Exiting 0 regardless of feature outcomes (metrics are truth).');
  process.exit(0);
}

function buildRunUrl(): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return null;
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
