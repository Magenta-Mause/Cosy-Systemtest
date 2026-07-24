import { defineConfig, devices } from '@playwright/test';
import { resolveBaseURL } from './tests/helpers/constants';

const isCI = !!process.env.CI;

/**
 * Chromium-only for now (add Firefox/WebKit once the suite is stable). Retries on
 * CI absorb transient blips against a freshly installed stack; locally we want
 * failures to surface immediately.
 *
 * CI parallelism is capped at 2 workers. Every game-server start pulls a Docker
 * image and boots a container on a 4-vCPU GitHub runner; when several pulls stack
 * up (the two heavy PaperMC servers plus the tosios specs) container starts stall
 * for minutes in AWAITING_UPDATE and previously-green specs 409/time-out (run 11).
 * Two workers keeps peak pull/boot pressure low — at most two specs pulling at
 * once — while still finishing well within the nightly budget. We do NOT further
 * serialise the two Minecraft specs: they pull the SAME `itzg/minecraft-server`
 * image, so once one worker has it the other reuses the cached layers; the real
 * lever is overall concurrency, handled here, plus the generous
 * SERVER_COLD_START_TIMEOUT_MS budgets and ApiClient.ensureRunning's
 * wait-until-startable guard. Locally (no CI) parallelism stays at the default.
 */
export default defineConfig({
  testDir: './tests/specs',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 2 } : {}),
  reporter: isCI
    ? [
        ['github'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'results/playwright-report.json' }],
      ]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'on-failure' }]],

  use: {
    baseURL: resolveBaseURL(),
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
