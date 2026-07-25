import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS, WS_MESSAGE_TIMEOUT_MS } from '@helpers/constants';

/**
 * The console view (LogDisplay). Logs stream in live over the WebSocket and are
 * rendered in a react-virtuoso list; the command input sits at the bottom and is
 * enabled only while the server is running.
 *
 * v1.1.0 ships Cosy-owned testids here: `console-log-list` (the container wrapping
 * Virtuoso), `console-command-input` and `console-send-btn`. react-virtuoso's own
 * `virtuoso-item-list` is still used for COUNTING rendered log lines — the Cosy
 * container wraps the scroller, so counting its children would always return 1 and
 * make "has output" vacuously true.
 *
 * v1.1.0 also made logs lazy (fd721cd): they are fetched only when a logs widget is
 * in the shown dashboard layout and the user holds READ_SERVER_LOGS, and a
 * "Loading logs …" overlay covers the list until the first fetch resolves. Wait past
 * that overlay before asserting or clicking.
 */
export class ConsolePage {
  constructor(private readonly page: Page) {}

  /** The Cosy-owned container around the virtualised log viewport. */
  private get logPanel(): Locator {
    return this.page.getByTestId('console-log-list');
  }

  /** react-virtuoso's item container — one child per rendered log line. */
  private get logItems(): Locator {
    return this.page.locator('[data-testid="virtuoso-item-list"]');
  }

  private get commandInput(): Locator {
    return this.page.getByTestId('console-command-input');
  }

  /** Wait until at least one log line has streamed into the console. */
  async expectHasLogOutput(timeout = WS_MESSAGE_TIMEOUT_MS): Promise<void> {
    await expect(this.logPanel).toBeVisible({ timeout });
    // Past the lazy-load overlay, then one child per log message once output arrives.
    await expect(this.page.getByText(/Loading logs/i)).toHaveCount(0, { timeout });
    await expect
      .poll(async () => (await this.logItems.locator('> *').count()) > 0, {
        timeout,
      })
      .toBe(true);
  }

  /**
   * Assert a log line matching `pattern` appears in the console (e.g. an RCON
   * command's response). Auto-scroll keeps the newest line rendered, so a recent
   * response is in the virtualized DOM.
   */
  async expectLogContains(pattern: RegExp, timeout = WS_MESSAGE_TIMEOUT_MS): Promise<void> {
    await expect(this.logPanel.getByText(pattern).first()).toBeVisible({ timeout });
  }

  /** Send a console command via the send button (v1.1.0 exposes it explicitly). */
  async sendCommand(command: string): Promise<void> {
    await expect(this.commandInput).toBeEnabled({ timeout: UI_ACTION_TIMEOUT_MS });
    await this.commandInput.fill(command);
    await this.page.getByTestId('console-send-btn').click();
  }
}
