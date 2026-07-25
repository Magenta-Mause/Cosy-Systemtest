import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  SERVER_START_TIMEOUT_MS,
  SERVER_STOP_TIMEOUT_MS,
  UI_ACTION_TIMEOUT_MS,
  WS_MESSAGE_TIMEOUT_MS,
} from '@helpers/constants';
import { detectUiStatusWedge } from '@helpers/docker';

/** UI labels for server statuses (i18n serverStatus.*). */
export const STATUS_LABEL = {
  RUNNING: 'Running',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
  PULLING_IMAGE: 'Pulling Image',
  STOPPING: 'Stopping...',
} as const;

/**
 * A game-server detail page (GameServerDetailPageLayout). Exposes the start/stop
 * control, the live status indicator (fed by the WebSocket store), tab navigation,
 * and the delete flow (under Settings → General → Uncosy Zone).
 *
 * Tab switching navigates by URL: the fancy nav buttons keep their text label
 * visually hidden until hover and expose no test id, so URL navigation is the
 * robust option here (see docs/testid-gaps.md).
 */
export class ServerDetailPage {
  constructor(private readonly page: Page, private readonly uuid: string) {}

  async gotoOverview(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}`);
  }

  async gotoConsole(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/console`);
  }

  async gotoFiles(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/files`);
  }

  async gotoGeneralSettings(): Promise<void> {
    await this.page.goto(`/server/${this.uuid}/settings/general`);
  }

  // Start/stop button — label is "Start" when stopped, "Shutdown" when running.
  // TODO(testid): add data-testid="server-start-stop-btn" to GameServerStartStopButton
  private get startButton(): Locator {
    return this.page.getByRole('button', { name: 'Start', exact: true });
  }

  private get stopButton(): Locator {
    return this.page.getByRole('button', { name: 'Shutdown', exact: true });
  }

  /** The start/stop control regardless of its current label ("Start" | "Shutdown"). */
  private get startStopButton(): Locator {
    // TODO(testid): add data-testid="server-start-stop-btn" to GameServerStartStopButton
    return this.page.getByRole('button', { name: /^(Start|Shutdown)$/ });
  }

  /**
   * Assert the live status indicator shows the expected status label.
   *
   * On timeout for RUNNING/STOPPED we ask Docker what the container is actually
   * doing. A container that is demonstrably up while the indicator never reached
   * "Running" is not a slow boot and not a bad selector — it is the backend's lost
   * Docker event stream (docs/KNOWN-ISSUES.md), and saying so beats a bare
   * "toBeVisible failed" that reads like a broken locator.
   */
  async expectStatus(status: keyof typeof STATUS_LABEL, timeout = WS_MESSAGE_TIMEOUT_MS): Promise<void> {
    try {
      // TODO(testid): add data-testid="server-status-indicator" to GameServerStatusIndicator
      await expect(this.page.getByText(STATUS_LABEL[status], { exact: false }).first()).toBeVisible({
        timeout,
      });
    } catch (err) {
      if (status === 'RUNNING' || status === 'STOPPED') {
        const wedge = detectUiStatusWedge(this.uuid, status);
        if (wedge) throw new Error(wedge, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Assert the start/stop control is present but DISABLED — used to verify a member
   * with SEE_SERVER but WITHOUT START_STOP_SERVER cannot control the server. The
   * button is ALWAYS rendered (GameServerStartStopButton); lacking the permission
   * only sets `disabled: !canStartStopServer` (plus a "noStartStopPermission"
   * tooltip), so the control is disabled, NOT absent.
   */
  async expectStartStopControlDisabled(): Promise<void> {
    await expect(this.startStopButton.first()).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await expect(this.startStopButton.first()).toBeDisabled({ timeout: UI_ACTION_TIMEOUT_MS });
  }

  async start(): Promise<void> {
    await this.startButton.click();
  }

  async stop(): Promise<void> {
    await this.stopButton.click();
  }

  /** Click start and wait until the live indicator reports RUNNING. */
  async startAndWaitRunning(): Promise<void> {
    await this.start();
    await this.expectStatus('RUNNING', SERVER_START_TIMEOUT_MS);
  }

  /** Click stop and wait until the live indicator reports STOPPED. */
  async stopAndWaitStopped(): Promise<void> {
    await this.stop();
    await this.expectStatus('STOPPED', SERVER_STOP_TIMEOUT_MS);
  }

  /**
   * Delete the server through the UI: Settings → Uncosy Zone → Delete, then type
   * the server name to confirm.
   */
  async deleteViaUi(serverName: string): Promise<void> {
    await this.gotoGeneralSettings();
    // TODO(testid): add data-testid="server-delete-btn" to UncosyZone delete Button
    await this.page.getByRole('button', { name: 'Delete', exact: true }).click();

    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    // Confirmation requires typing the exact server name (id="serverName").
    // TODO(testid): add data-testid="delete-confirm-input" to DeleteGameServerAlertDialog input
    await dialog.locator('#serverName').fill(serverName);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    // On success the app redirects to home with ?deleted=true.
    await this.page.waitForURL(/\/(\?.*)?$/, { timeout: UI_ACTION_TIMEOUT_MS });
  }
}
