/**
 * Phase-1 systemtest runner.
 *
 * Runs the Playwright suite, parses the JSON report into one row per feature
 * (spec file), writes `results/summary.json`, and prints a table.
 *
 * Semantics: "metrics are truth, exit 0". Test failures do NOT fail this process
 * — the per-feature results are the signal, and the dashboard/alerts (Phase 3)
 * decide what is broken. The process exits non-zero ONLY on an infrastructure
 * error: Playwright could not produce a parseable report at all.
 *
 * OTLP metric push is not wired yet (Phase 3) — see `pushMetrics()`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.resolve('results');
const JSON_REPORT = path.join(RESULTS_DIR, 'playwright-report.json');
const SUMMARY = path.join(RESULTS_DIR, 'summary.json');

type FeatureStatus = 'passed' | 'failed' | 'skipped';

interface FeatureResult {
  feature: string;
  status: FeatureStatus;
  durationSeconds: number;
}

interface Summary {
  channel: string;
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

function writeSummary(features: FeatureResult[]): Summary {
  const summary: Summary = {
    channel: process.env.COSY_CHANNEL ?? 'release',
    generatedAt: new Date().toISOString(),
    runUrl: buildRunUrl(),
    features,
  };
  fs.writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function printTable(summary: Summary): void {
  const icon = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' } as const;
  console.log(`\n=== Cosy systemtest results (channel: ${summary.channel}) ===`);
  for (const f of summary.features) {
    console.log(`  ${icon[f.status]}  ${f.feature.padEnd(20)} ${f.durationSeconds}s`);
  }
  const failed = summary.features.filter((f) => f.status === 'failed').length;
  console.log(`  ---\n  ${summary.features.length} features, ${failed} failed`);
}

/**
 * Phase 3: push the per-feature results to SigNoz over OTLP-HTTP. Not implemented
 * yet — Phase 1 is a reporting dry-run (results only as GitHub artifacts).
 */
export function pushMetrics(_summary: Summary): never {
  throw new Error(
    'pushMetrics(): OTLP metric push is Phase 3 — not implemented yet. ' +
      'Phase 1 reports results only as the results/ artifact.',
  );
}

function main(): void {
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

  const summary = writeSummary(features);
  printTable(summary);
  console.log(
    `\nReporting dry-run (Phase 1): wrote ${path.relative(process.cwd(), SUMMARY)} — ` +
      'no OTLP push. Exiting 0 regardless of test outcomes.',
  );
  // Metrics-are-truth: never fail the process on red tests.
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

main();
