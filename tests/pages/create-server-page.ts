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
// Type at a human cadence, not machine speed: verified locally (released frontend
// 5dba6e8, dev + prod builds, real dialog with/without data) that both fast and
// 60ms-delayed keystrokes persist the controlled-input value without crashing.
// A user-like delay is the realistic write and costs a fraction of a second.
const KEYSTROKE_DELAY_MS = 60;

export class CreateServerPage {
  /** Set if a React "maximum update depth"/#185 error is observed on the page. */
  private reactCrash: string | null = null;

  constructor(private readonly page: Page) {
    // The released create wizard has been seen to blank out with React #185
    // (maximum update depth) during the create flow in CI. Capture it so a crash
    // surfaces as a clear, truthful failure instead of a misleading "value did not
    // persist" (the input vanishes when the app unmounts). See docs/KNOWN-ISSUES.md.
    const record = (text: string) => {
      if (/Maximum update depth|Minified React error #185|error #185|#185/i.test(text)) {
        this.reactCrash ??= text;
      }
    };
    page.on('pageerror', (e) => record(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') record(m.text());
    });
  }

  private get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  private field(id: string): Locator {
    // TODO(testid): replace #id with data-testid on GenericGameServerCreationInputField
    return this.dialog.locator(`#${id}`);
  }

  /**
   * If the wizard crashed (React #185) or the app blanked out during an
   * interaction, throw a clear, truthful error naming the real symptom. Returns
   * normally when no crash is detected (so the caller rethrows its own diagnostic).
   */
  private async throwIfCrashed(during: string): Promise<void> {
    const dialogGone = (await this.dialog.count()) === 0;
    const rootLen = (await this.page.locator('#root').innerHTML().catch(() => '')).length;
    const blanked = dialogGone && rootLen < 200;
    if (this.reactCrash || blanked) {
      throw new Error(
        `Released create wizard CRASHED while ${during}: the app unmounted ` +
          `(${this.reactCrash ? `React "${this.reactCrash.split('\n')[0]}"` : 'page blanked out'}). ` +
          `This is a released Cosy v1.0.3 defect surfaced by the systemtest — the create ` +
          `feature is genuinely broken in that run. See docs/KNOWN-ISSUES.md.`,
      );
    }
  }

  /** Enter text into a controlled input via real (human-cadence) keystrokes and assert it stuck. */
  private async typeInto(locator: Locator, value: string, what: string): Promise<void> {
    await locator.click();
    await locator.press('ControlOrMeta+a');
    await locator.press('Delete');
    await locator.pressSequentially(value, { delay: KEYSTROKE_DELAY_MS });
    try {
      await expect(locator).toHaveValue(value, { timeout: UI_ACTION_TIMEOUT_MS });
    } catch (e) {
      await this.throwIfCrashed(`typing the ${what}`);
      // Not a crash — the controlled input genuinely failed to commit.
      throw new Error(
        `${what}: value "${value}" did not persist — the controlled React input never ` +
          `committed to gameServerState (a fill()-style single-event write was reverted).`,
        { cause: e },
      );
    }
  }

  /** Assert a wizard advance button is enabled (fail fast) and click it. */
  private async advance(label: string, step: string, exact = false): Promise<void> {
    const btn = this.dialog.getByRole('button', { name: label, exact });
    try {
      await expect(btn).toBeEnabled({ timeout: UI_ACTION_TIMEOUT_MS });
    } catch (e) {
      await this.throwIfCrashed(`advancing past ${step}`);
      throw new Error(
        `${step}: "${label}" never became enabled — wizard step validation was not ` +
          `satisfied (a required controlled input did not register as touched+valid).`,
        { cause: e },
      );
    }
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
