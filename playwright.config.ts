import { defineConfig, devices } from '@playwright/test';
import { resolveBaseURL, UI_ACTION_TIMEOUT_MS } from './tests/helpers/constants';

const isCI = !!process.env.CI;

/**
 * Chromium-only for now (add Firefox/WebKit once the suite is stable). Retries on
 * CI absorb transient blips against a freshly installed stack; locally we want
 * failures to surface immediately.
 *
 * CI runs SERIALLY (workers: 1). This is a reliability-focused monitoring suite and
 * parallelism has repeatedly caused two distinct failure classes on the 4-vCPU
 * GitHub runner: (a) concurrent Docker image pulls (two Minecraft servers, or a
 * Minecraft pull next to the tosios specs) starving the light tosios servers into
 * AWAITING_UPDATE for 900s+ (runs 11/14); (b) the shared-BY-NAME servers racing
 * across workers (start() 409s). Serial execution guarantees only ONE server
 * pulls/boots at a time — run 13 proved a single Minecraft coexists fine with the
 * tosios specs — eliminating the whole contention + race class. Wall-clock ~20-25 min
 * is fine for a nightly / on-release suite. Locally (no CI) parallelism stays at the
 * default.
 *
 * `timeout` (global): worker-scoped fixture SETUP is bounded by the GLOBAL test
 * timeout, NOT `test.describe.configure({ timeout })` (verified run 14: the
 * `minecraftServer` fixture died at the 30s default despite a 720s describe timeout).
 * Raise the global to 600s so that fixture's cold PaperMC boot (bounded internally to
 * MINECRAFT_READY_TIMEOUT_MS = 7 min) fits. Per-spec bodies still set their own
 * (usually tighter) describe timeouts.
 */
export default defineConfig({
  testDir: './tests/specs',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  timeout: 600_000,
  ...(isCI ? { workers: 1 } : {}),
  reporter: isCI
    ? [
        ['github'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'results/playwright-report.json' }],
      ]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'on-failure' }]],

  use: {
    baseURL: resolveBaseURL(),
    // Bound every ACTION (click/fill/press). Playwright's default is 0 = "wait as
    // long as the test allows", which turns a locator that matches nothing into a
    // silent hang consuming the entire test budget and reported only as a generic
    // "Test timeout exceeded" — run 16 burned 117s that way on a single click whose
    // selector was wrong. A bounded action fails at the real call site with
    // Playwright's own "waiting for locator(…)" diagnostic, which names the culprit.
    // Assertions keep their own explicit, longer timeouts.
    actionTimeout: UI_ACTION_TIMEOUT_MS,
    // Trace always: a nightly failure must be fully debuggable from the artifact
    // alone (no local repro on a throwaway runner).
    trace: 'on',
    // Record every run, not just failures: this is a monitoring suite, so we want
    // to be able to watch a green nightly too (confirm the UI actually did the
    // right thing), not only debug red ones.
    video: 'on',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
