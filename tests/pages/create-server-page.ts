import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { SERVER_START_TIMEOUT_MS, UI_ACTION_TIMEOUT_MS } from '@helpers/constants';

/**
 * The three-step create-server wizard, derived from the RELEASED frontend
 * (revision 5dba6e8, the image pinned by installer v1.0.3):
 *   Step 1 "Choose name and Game"  — server name + optional game → "Next Step"
 *   Step 2 "Choose Template"        — none for a generic game → "Continue without Template"
 *   Step 3 "Configure your Server"  — Docker image (+ RAM, + optional volume) →
 *                                     "Create Server" → confirm dialog
 *
 * INPUT HANDLING — why keystrokes, not fill(): every wizard field is a *fully
 * controlled* React input (`value={gameServerState[attr]}`, onChange →
 * setGameServerState). Step advance buttons are enabled only when
 * GenericGameServerCreationPage sees each attribute touched AND valid, both derived
 * from the committed `gameServerState`. Playwright's `fill()` dispatches a single
 * synthetic `input` event which does not reliably commit into that controlled state
 * (the binding snaps the DOM value back to empty), so validation never satisfies and
 * the advance button stays `disabled`. `pressSequentially()` fires a real event per
 * keystroke — like a user — and commits. We then assert the value persisted and the
 * advance button became enabled, so a regression fails in seconds with a clear
 * message instead of hanging on actionability.
 *
 * Fields carry stable `id`s (`server_name`, `docker_image_name`, `docker_max_memory`);
 * the optional volume-mount row is matched by its `/data` placeholder. No
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

  /** Enter text into a controlled input via real keystrokes and assert it stuck. */
  private async typeInto(locator: Locator, value: string, what: string): Promise<void> {
    await locator.click();
    await locator.press('ControlOrMeta+a');
    await locator.press('Delete');
    await locator.pressSequentially(value);
    await expect(
      locator,
      `${what}: value "${value}" did not persist — the controlled React input never ` +
        `committed to gameServerState (a fill()-style single-event write was reverted).`,
    ).toHaveValue(value, { timeout: UI_ACTION_TIMEOUT_MS });
  }

  /** Assert a wizard advance button is enabled (fail fast) and click it. */
  private async advance(label: string, step: string, exact = false): Promise<void> {
    const btn = this.dialog.getByRole('button', { name: label, exact });
    await expect(
      btn,
      `${step}: "${label}" never became enabled — wizard step validation was not ` +
        `satisfied (a required controlled input did not register as touched+valid).`,
    ).toBeEnabled({ timeout: UI_ACTION_TIMEOUT_MS });
    await btn.click();
  }

  /**
   * Full flow: create a server with a custom Docker image + memory limit (and an
   * optional volume mount) and confirm creation. Leaves the SuccessDialog open.
   */
  async createWithCustomImage(opts: {
    serverName: string;
    dockerImage: string;
    imageTag?: string;
    memoryLimit: string;
    /** Optional container path for a volume mount, e.g. "/data" — needed for file ops. */
    volumeMount?: string;
  }): Promise<void> {
    // Step 1 "Choose name and Game": name the server (the game is optional).
    await this.typeInto(this.field('server_name'), opts.serverName, 'server name');
    await this.advance('Next Step', 'step 1 (name/game)');

    // Step 2 "Choose Template": a generic game has no templates → continue without one.
    await this.advance('Continue without Template', 'step 2 (template)');

    // Step 3 "Configure your Server": custom Docker image + RAM limit (+ volume).
    await this.typeInto(this.field('docker_image_name'), opts.dockerImage, 'docker image');
    // The tag field defaults to "latest"; only override when a different tag is asked for.
    if (opts.imageTag && opts.imageTag !== 'latest') {
      await this.typeInto(this.field('docker_image_tag'), opts.imageTag, 'image tag');
    }
    await this.typeInto(this.field('docker_max_memory'), opts.memoryLimit, 'memory limit');
    if (opts.volumeMount) {
      // The volume-mount ListInput always renders one empty row; type into it
      // directly (no "Add" needed). Placeholder "/data" is unique on this step.
      // TODO(testid): add data-testid="create-volume-mount-input" to VolumeMountInput
      await this.typeInto(this.dialog.getByPlaceholder('/data'), opts.volumeMount, 'volume mount');
    }
    await this.advance('Create Server', 'step 3 (configure)', true);

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
