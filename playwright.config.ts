import { defineConfig, devices } from '@playwright/test';
import { resolveBaseURL } from './tests/helpers/constants';

const isCI = !!process.env.CI;

/**
 * Chromium-only for now (add Firefox/WebKit once the suite is stable). Retries on
 * CI absorb transient blips against a freshly installed stack; locally we want
 * failures to surface immediately. Workers are left to Playwright's default —
 * specs provision/clean their own state (or share via a worker-scoped fixture),
 * so nothing forces `workers=1`.
 */
export default defineConfig({
  testDir: './tests/specs',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
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
