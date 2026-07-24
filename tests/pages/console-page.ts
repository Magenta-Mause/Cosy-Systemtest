import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { UI_ACTION_TIMEOUT_MS, WS_MESSAGE_TIMEOUT_MS } from '@helpers/constants';

/**
 * The console view (LogDisplay). Logs stream in live over the WebSocket and are
 * rendered in a react-virtuoso list; the command input sits at the bottom and is
 * enabled only while the server is running.
 *
 * The log list is targeted via react-virtuoso's built-in
 * `data-testid="virtuoso-item-list"`; the command input via its placeholder. No
 * Cosy-owned test ids exist yet (see docs/testid-gaps.md).
 */
export class ConsolePage {
  constructor(private readonly page: Page) {}

  private get logList(): Locator {
    // react-virtuoso emits this test id on its item container.
    return this.page.locator('[data-testid="virtuoso-item-list"]');
  }

  private get commandInput(): Locator {
    // Placeholder is "Enter command..." while the server is running.
    // TODO(testid): add data-testid="console-command-input" to LogDisplay Input
    return this.page.getByPlaceholder('Enter command...');
  }

  /** Wait until at least one log line has streamed into the console. */
  async expectHasLogOutput(timeout = WS_MESSAGE_TIMEOUT_MS): Promise<void> {
    await expect(this.logList).toBeVisible({ timeout });
    // The list renders one child per log message once output arrives.
    await expect
      .poll(async () => (await this.logList.locator('> *').count()) > 0, {
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
    await expect(this.logList.getByText(pattern).first()).toBeVisible({ timeout });
  }

  /** Send a console command (submitted on Enter). */
  async sendCommand(command: string): Promise<void> {
    await expect(this.commandInput).toBeEnabled({ timeout: UI_ACTION_TIMEOUT_MS });
    await this.commandInput.fill(command);
    await this.commandInput.press('Enter');
  }
}
