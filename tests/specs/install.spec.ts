import { test, expect, runsOnlyWithInstall } from '@fixtures/index';
import { HEALTH_PATH } from '@helpers/constants';
import { parseCredentialsFromLog, readCredentialsFromEnvFile } from '@helpers/install';

/**
 * Feature: install — a fresh-machine install via install_cosy.sh yields a healthy
 * stack, a reachable UI, and a printed summary whose admin credentials are real
 * (and match the generated .env).
 */
test.describe('@core install', () => {
  runsOnlyWithInstall();

  test('the stack reports healthy via actuator', async ({ request }) => {
    const res = await request.get(HEALTH_PATH);
    expect(res.ok(), `health endpoint ${HEALTH_PATH} should return 2xx`).toBeTruthy();
    // The backend wraps every response in a global envelope, so the actuator
    // payload sits under `.data` (`{ data: { status: "UP", ... }, success, ... }`).
    const body = (await res.json()) as { data?: { status?: string } };
    // The workflow distinguishes degraded (some component DOWN) from OK; here we
    // assert the overall status is UP.
    expect(body.data?.status, 'overall actuator status').toBe('UP');
  });

  test('the UI is reachable', async ({ page }) => {
    await page.goto('/');
    // Unauthenticated home shows the login banner "Sign In" call to action.
    await expect(page.getByRole('button', { name: 'Sign In' }).first()).toBeVisible();
  });

  test('the installer stdout prints admin credentials that match .env', async () => {
    const logPath = process.env.INSTALL_LOG!;
    const fromLog = await test.step('Given: credentials parsed from the installer summary', () => {
      const creds = parseCredentialsFromLog(logPath);
      expect(creds.username, 'parsed username').toBeTruthy();
      expect(creds.password, 'parsed password').toBeTruthy();
      return creds;
    });

    const fromEnv = await test.step('When: reading credentials from the generated .env', () => {
      return readCredentialsFromEnvFile();
    });

    await test.step('Then: the printed summary matches .env (summary is not lying)', () => {
      expect(fromLog.username).toBe(fromEnv.username);
      expect(fromLog.password).toBe(fromEnv.password);
    });
  });
});
