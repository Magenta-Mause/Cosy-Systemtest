import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ApiClient } from '@helpers/api';
import type { GameServer } from '@helpers/api';
import { resolveAdminCredentials } from '@helpers/install';
import type { AdminCredentials } from '@helpers/install';
import { SHARED_SERVER_NAME, TEST_SERVER_MEMORY_LIMIT } from '@helpers/constants';
import { LoginPage } from '@pages/index';

/** Uniform skip reason so the report reads the same for every install-gated spec. */
const NO_INSTALL_REASON =
  'INSTALL_LOG not set — no Cosy install present. Runs only in the systemtest workflow.';

/**
 * Skip guard: specs that need an installed stack call this in their describe body.
 * Keeps every spec locally *listable* (`playwright test --list`) without an install,
 * and makes them skip with one consistent reason instead of erroring.
 */
export function runsOnlyWithInstall(): void {
  test.skip(!process.env.INSTALL_LOG, NO_INSTALL_REASON);
}

/**
 * Admin credentials are resolved once per worker (parse installer stdout +
 * cross-check `.env`) and cached, so the expensive parse/mismatch check runs a
 * single time even though many tests depend on it.
 */
let cachedCreds: AdminCredentials | null = null;
function getAdminCredentials(): AdminCredentials {
  if (!cachedCreds) cachedCreds = resolveAdminCredentials();
  return cachedCreds;
}

type WorkerFixtures = {
  adminCreds: AdminCredentials;
  apiClient: ApiClient;
  /** Reusable tosios server (get-or-create) shared across lifecycle/console/files. */
  sharedServer: GameServer;
};

type TestFixtures = {
  /** Fresh context already logged into the UI with the parsed admin credentials. */
  loggedInPage: Page;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  adminCreds: [
    async ({}, use) => {
      await use(getAdminCredentials());
    },
    { scope: 'worker' },
  ],

  apiClient: [
    async ({ adminCreds }, use) => {
      const client = new ApiClient();
      await client.login(adminCreds);
      await use(client);
    },
    { scope: 'worker' },
  ],

  sharedServer: [
    async ({ apiClient }, use) => {
      const server = await apiClient.getOrCreateTosiosServer(
        SHARED_SERVER_NAME,
        TEST_SERVER_MEMORY_LIMIT,
      );
      await use(server);
    },
    { scope: 'worker' },
  ],

  loggedInPage: async ({ browser, adminCreds }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const loginPage = new LoginPage(page);
      await loginPage.navigate();
      await loginPage.login(adminCreds.username, adminCreds.password);
      await use(page);
    } finally {
      await context.close();
    }
  },
});

export { expect } from '@playwright/test';
