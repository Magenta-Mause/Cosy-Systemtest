import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SERVER_START_TIMEOUT_MS, UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The three-step create-server wizard (CreateGameServerModal):
 *   Step 1 — game / template selection  → "Continue without Template"
 *   Step 2 — server name (+ template)   → "Continue without Template"
 *   Step 3 — Docker image + hardware    → "Create Server" → confirm dialog
 *
 * Form fields carry stable `id`s (`server_name`, `docker_image_name`,
 * `docker_max_memory`); other controls are matched by their (i18n English) button
 * text. No `data-testid`s yet — see docs/testid-gaps.md.
 */
export class CreateServerPage {
  constructor(private readonly page: Page) {}

  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  // Wizard "next" button. Steps 1 and 2 (without a template) both label it
  // "Continue without Template"; step 3 labels it "Create Server".
  // TODO(testid): add data-testid="create-server-next-btn" to GameServerCreationButton
  private nextButton(name: RegExp): Locator {
    return this.dialog.getByRole('button', { name });
  }

  private field(id: string): Locator {
    // TODO(testid): replace #id with data-testid on GenericGameServerCreationInputField
    return this.dialog.locator(`#${id}`);
  }

  /**
   * Full flow: create a server with a custom Docker image + memory limit and
   * confirm creation. Leaves the SuccessDialog open (caller can open the server).
   */
  async createWithCustomImage(opts: {
    serverName: string;
    dockerImage: string;
    imageTag?: string;
    memoryLimit: string;
  }): Promise<void> {
    // Step 1 — skip template selection.
    await this.nextButton(/Continue without Template/).click();

    // Step 2 — name the server, then continue.
    await this.field('server_name').fill(opts.serverName);
    await this.nextButton(/Continue without Template/).click();

    // Step 3 — Docker image + RAM limit.
    await this.field('docker_image_name').fill(opts.dockerImage);
    if (opts.imageTag) {
      await this.field('docker_image_tag').fill(opts.imageTag);
    }
    await this.field('docker_max_memory').fill(opts.memoryLimit);

    // Trigger creation → confirmation dialog.
    await this.dialog.getByRole('button', { name: 'Create Server', exact: true }).click();

    // Confirm dialog: title "Create Server?", confirm button "Create Server".
    const confirm = this.page.getByRole('alertdialog');
    await expect(confirm).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await confirm.getByRole('button', { name: 'Create Server', exact: true }).click();
  }

  /** Wait for the success dialog and open the created server's dashboard. */
  async openCreatedServer(): Promise<void> {
    const success = this.page.getByRole('dialog').filter({ hasText: 'Server Created!' });
    await expect(success).toBeVisible({ timeout: SERVER_START_TIMEOUT_MS });
    await success.getByRole('button', { name: 'Open Dashboard' }).click();
  }
}
