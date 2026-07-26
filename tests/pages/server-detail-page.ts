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
 * Tab switching navigates by URL. v1.1.0 added `server-tab-<key>` testids
 * (overview / console / metrics / file_explorer / settings) so real tab clicks are
 * now possible, but URL navigation is kept: it is what the specs actually need and
 * it does not depend on the nav rail being rendered at the current viewport.
 *
 * BUTTON LABELS ARE NOT STABLE MID-ACTION (v1.1.0): a loading Button replaces its
 * children with a loading label, so start/stop reads "Starting" / "Stopping..."
 * while the request is in flight. Controls are therefore addressed by testid and the
 * label is asserted separately, as a state check rather than as a selector.
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

  /** The single start/stop control, whatever its current label. */
  private get startStopButton(): Locator {
    return this.page.getByTestId('server-start-stop-btn');
  }

  /**
   * Click the start/stop control, first asserting it currently offers `expected`
   * ("Start" when stopped, "Shutdown" when running). Asserting the label before
   * clicking keeps the old selector's safety — it fails loudly if the server is not
   * in the state the caller assumed — without breaking when the label flips to
   * "Starting" / "Stopping..." on click.
   */
  private async clickStartStop(expected: 'Start' | 'Shutdown'): Promise<void> {
    const btn = this.startStopButton;
    await expect(
      btn,
      `start/stop control did not read "${expected}" — the server is not in the state ` +
        `this action assumed`,
    ).toHaveText(expected, { timeout: UI_ACTION_TIMEOUT_MS });
    await btn.click();
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
      await expect(this.page.getByTestId('server-status-indicator')).toContainText(
        STATUS_LABEL[status],
        { timeout },
      );
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

  /**
   * Assert the server does NOT reach `status` for the whole window.
   *
   * `expect(...).not.toContainText()` cannot express this: it passes the moment the
   * text does not match, which is already true before a start would have had any
   * chance to happen. Proving a start was really refused needs the negative held over
   * time, so the indicator is sampled until the window is up.
   */
  async expectStatusNeverBecomes(
    status: keyof typeof STATUS_LABEL,
    windowMs: number,
  ): Promise<void> {
    const indicator = this.page.getByTestId('server-status-indicator');
    const deadline = Date.now() + windowMs;
    do {
      await expect(
        indicator,
        `server reached ${status} although its host port is taken`,
      ).not.toContainText(STATUS_LABEL[status], { timeout: UI_ACTION_TIMEOUT_MS });
      await this.page.waitForTimeout(1_000);
    } while (Date.now() < deadline);
  }

  async start(): Promise<void> {
    await this.clickStartStop('Start');
  }

  async stop(): Promise<void> {
    await this.clickStartStop('Shutdown');
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
    await this.page.getByTestId('server-delete-btn').click();

    const dialog = this.page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    // Confirmation requires typing the exact server name.
    await dialog.getByTestId('delete-confirm-input').fill(serverName);
    await dialog.getByTestId('delete-confirm-btn').click();

    // On success the app redirects to home with ?deleted=true.
    await this.page.waitForURL(/\/(\?.*)?$/, { timeout: UI_ACTION_TIMEOUT_MS });
  }
}
