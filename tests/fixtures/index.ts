import { test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { ApiClient } from '@helpers/api';
import type { GameServer, ProvisionedUser } from '@helpers/api';
import { resolveAdminCredentials } from '@helpers/install';
import type { AdminCredentials } from '@helpers/install';
import {
  MINECRAFT_ENV,
  MINECRAFT_IMAGE,
  MINECRAFT_MEMORY_GIB,
  MINECRAFT_READY_TIMEOUT_MS,
  SHARED_MINECRAFT_NAME,
  SHARED_SERVER_NAME,
  TEST_SERVER_MEMORY_LIMIT,
} from '@helpers/constants';
import { startWebhookSink } from '@helpers/webhook-sink';
import type { WebhookSink } from '@helpers/webhook-sink';
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

/** Uniform skip reason for the quarantined heavy spec. */
const NO_HEAVY_REASON =
  'SYSTEMTEST_HEAVY not set — heavy Minecraft spec, quarantined on CI runners. ' +
  'See docs/KNOWN-ISSUES.md ("rcon is quarantined").';

/**
 * Guard for specs that need a full Minecraft server to boot. On a GitHub-hosted
 * 4-vCPU runner that has never succeeded (see docs/KNOWN-ISSUES.md), and each
 * attempt burns ~20 minutes, so the nightly skips them and reports them as SKIPPED
 * — honest and visible in the matrix — rather than as a 20-minute red. Set
 * `SYSTEMTEST_HEAVY=1` to run them locally or on a beefier runner.
 */
export function runsOnlyWithHeavyEnabled(): void {
  test.skip(!process.env.SYSTEMTEST_HEAVY, NO_HEAVY_REASON);
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
  /**
   * Reusable Minecraft (itzg/PaperMC) server, RUNNING and past itzg readiness.
   * Provisioned over the API so the `rcon` spec has a real RCON-capable server.
   *
   * This is the SUITE'S ONLY Minecraft boot: `server-from-template` switched to the
   * tiny TOSIOS catalog template, so there is no longer a second concurrent PaperMC
   * pull to contend on the 4-vCPU runner. rcon stays on Minecraft because TOSIOS has
   * no RCON — the itzg image is what makes the RCON round-trip testable.
   */
  minecraftServer: GameServer;
};

/** A second, non-admin account plus a UI context already logged in as them. */
export interface SecondUserContext {
  user: ProvisionedUser;
  page: Page;
  context: BrowserContext;
}

type TestFixtures = {
  /** Fresh context already logged into the UI with the parsed admin credentials. */
  loggedInPage: Page;
  /**
   * A provisioned QUOTA_USER (created + password-change completed over the API)
   * with a browser context already logged in as them. Torn down (user deleted)
   * after the test. Used by access-management for the "restricted user" side.
   */
  secondUserContext: SecondUserContext;
  /** A local HTTP sink (0.0.0.0) with a container-reachable URL for webhook delivery. */
  webhookSink: WebhookSink;
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

  minecraftServer: [
    async ({ apiClient }, use) => {
      const server = await apiClient.getOrCreateServer({
        server_name: SHARED_MINECRAFT_NAME,
        docker_image_name: MINECRAFT_IMAGE,
        docker_image_tag: 'latest',
        memory_limit: `${MINECRAFT_MEMORY_GIB}GiB`,
        environment_variables: MINECRAFT_ENV,
      });
      await apiClient.ensureRunning(server.uuid, MINECRAFT_READY_TIMEOUT_MS);
      // itzg prints "Done (…)! For help, type ..." once the world is generated and
      // the server is accepting connections (and RCON is up).
      await apiClient.waitForLogMatch(server.uuid, /Done \(|RCON running/i, MINECRAFT_READY_TIMEOUT_MS);
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

  secondUserContext: async ({ browser, apiClient }, use) => {
    const username = `st-user-${Date.now()}`;
    const password = 'Systemtest-Pw-2!';
    const user = await apiClient.provisionUser(username, password);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const loginPage = new LoginPage(page);
      await loginPage.navigate();
      await loginPage.login(user.username, user.password);
      await use({ user, page, context });
    } finally {
      await context.close();
      await apiClient.deleteUser(user.uuid).catch(() => {});
    }
  },

  webhookSink: async ({}, use) => {
    const sink = await startWebhookSink();
    try {
      await use(sink);
    } finally {
      await sink.close();
    }
  },
});

export { expect } from '@playwright/test';
