import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SERVER_START_TIMEOUT_MS, UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The three-step create-server wizard, derived from the RELEASED frontend
 * (revision 5dba6e8, the image pinned by installer v1.0.3) — its flow differs
 * from main:
 *   Step 1 "Choose name and Game"  — server name + optional game → "Next Step"
 *   Step 2 "Choose Template"        — none for a generic game → "Continue without Template"
 *   Step 3 "Configure your Server"  — Docker image (+ RAM, + optional volume) →
 *                                     "Create Server" → confirm dialog
 *
 * Form fields carry stable `id`s (`server_name`, `docker_image_name`,
 * `docker_max_memory`); the optional volume-mount row is matched by its `/data`
 * placeholder. Other controls are matched by their (English) button text. No
 * `data-testid`s exist in this release — see docs/testid-gaps.md.
 */
export class CreateServerPage {
  constructor(private readonly page: Page) {}

  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  private field(id: string): Locator {
    // TODO(testid): replace #id with data-testid on GenericGameServerCreationInputField
    return this.dialog.locator(`#${id}`);
  }

  /**
   * Full flow: create a server with a custom Docker image + memory limit (and an
   * optional volume mount) and confirm creation. Leaves the SuccessDialog open
   * (caller can open the server).
   */
  async createWithCustomImage(opts: {
    serverName: string;
    dockerImage: string;
    imageTag?: string;
    memoryLimit: string;
    /** Optional container path for a volume mount, e.g. "/data" — needed for file ops. */
    volumeMount?: string;
  }): Promise<void> {
    // Step 1 "Choose name and Game": name the server. The game field is optional
    // (leaving it empty falls back to a generic game with no templates); its
    // validator always passes, so "Next Step" enables once the name is filled.
    await this.field('server_name').fill(opts.serverName);
    await this.dialog.getByRole('button', { name: 'Next Step' }).click();

    // Step 2 "Choose Template": a generic game has no templates → continue without one.
    await this.dialog.getByRole('button', { name: 'Continue without Template' }).click();

    // Step 3 "Configure your Server": custom Docker image + RAM limit (+ volume).
    await this.field('docker_image_name').fill(opts.dockerImage);
    if (opts.imageTag) {
      await this.field('docker_image_tag').fill(opts.imageTag);
    }
    await this.field('docker_max_memory').fill(opts.memoryLimit);
    if (opts.volumeMount) {
      // The volume-mount ListInput always renders one empty row; fill it directly
      // (no "Add" needed). Placeholder "/data" is unique on this step.
      // TODO(testid): add data-testid="create-volume-mount-input" to VolumeMountInput
      await this.dialog.getByPlaceholder('/data').fill(opts.volumeMount);
    }
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
    // Released label is "Go to dashboard" (main uses "Open Dashboard").
    await success.getByRole('button', { name: 'Go to dashboard' }).click();
  }
}
