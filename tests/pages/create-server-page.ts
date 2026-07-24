import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  SERVER_START_TIMEOUT_MS,
  UI_ACTION_TIMEOUT_MS,
  UI_FLOW_TIMEOUT_MS,
} from '@helpers/constants';

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

  /**
   * The RAM limit is a COMPOUND widget (MemoryLimitInput), not a plain text input:
   * a numeric `<input type="number">` (its DOM value is just the number, e.g. "512")
   * plus a separate unit `<Select>` ("MiB" | "GiB", default "MiB"). It emits
   * `${number}${unit}` (e.g. "512MiB") to the parent. So we type only the numeric
   * part into the number input and, only when the unit differs from the default,
   * pick it from the select. `id="docker_max_memory"` lands on the numeric input.
   */
  private async setMemoryLimit(memory: string): Promise<void> {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(MiB|GiB)?\s*$/.exec(memory);
    if (!m) {
      throw new Error(`Unrecognised memory limit "${memory}" (expected e.g. "512MiB" or "2GiB").`);
    }
    const numeric = m[1];
    const unit = (m[2] ?? 'MiB') as 'MiB' | 'GiB';

    const numInput = this.field('docker_max_memory');
    await numInput.click();
    await numInput.press('ControlOrMeta+a');
    await numInput.press('Delete');
    await numInput.pressSequentially(numeric, { delay: KEYSTROKE_DELAY_MS });
    try {
      // Assert the NUMERIC value (the widget never holds the "512MiB" string).
      await expect(numInput).toHaveValue(numeric, { timeout: UI_ACTION_TIMEOUT_MS });
    } catch (e) {
      await this.throwIfCrashed('typing the memory limit');
      throw new Error(
        `memory limit: numeric value "${numeric}" did not persist in the number input.`,
        { cause: e },
      );
    }

    if (unit !== 'MiB') {
      // The unit <Select> (Radix combobox) lives in the memory input's end decorator,
      // a sibling of the numeric input within the same wrapper.
      // TODO(testid): add data-testid="memory-unit-select" to MemoryLimitInput's Select
      const unitSelect = numInput.locator('xpath=..').getByRole('combobox');
      await unitSelect.click();
      await this.page.getByRole('option', { name: unit, exact: true }).click();
      await expect(unitSelect).toContainText(unit, { timeout: UI_ACTION_TIMEOUT_MS });
    }
  }

  /**
   * Select a game so `external_game_id` becomes touched+valid (required to advance
   * step 1). We pick the always-present generic fallback item ("Generic Game"):
   *   - it is rendered client-side by `alwaysIncludeFallback`, so it works even if
   *     the hosted games API is unreachable / returns nothing (robust + offline-safe);
   *   - it selects no template, so step 3's Docker image stays empty and editable,
   *     keeping a clean path to the custom `halftheopposite/tosios` image.
   */
  private async selectGenericGame(): Promise<void> {
    // The generic fallback option (i18n gameSelection.noResultsLabel = "Generic Game").
    // TODO(testid): add data-testid="game-option-generic" to the fallback AutoComplete row
    await this.selectGame('Generic Game', {
      notFound:
        'step 1: the generic-game fallback option never appeared in the game autocomplete',
    });
  }

  /**
   * Select a game in step 1's `#external_game_id` autocomplete by (accessible)
   * name. Selecting a REAL game (e.g. Minecraft) is what makes that game's
   * templates available in step 2 — the template-creation flow builds on this.
   * A game selection is what registers `external_game_id` as touched+valid, so
   * this is also the gate that lets "Next Step" enable (naming alone never does).
   */
  async selectGame(
    name: string | RegExp,
    opts: { notFound?: string; expectedValue?: string | RegExp } = {},
  ): Promise<void> {
    const game = this.field('external_game_id');
    await game.click(); // defaultOpen: focus/click opens the game popover
    const option = this.page.getByRole('option', { name }).first();
    await expect(
      option,
      opts.notFound ?? `step 1: game "${name}" was not offered in the game autocomplete`,
    ).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await option.click();
    // After selection the game input shows the chosen label.
    await expect(game).toHaveValue(opts.expectedValue ?? name, {
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  /**
   * Select a game resiliently against the flaky hosted games API (cosy-game-api /
   * SteamGridDB): the first popover query can return empty / be slow / be
   * rate-limited, so re-type the query and retry the whole selection (open → option
   * visible → click → value committed) within a generous budget. Used by the
   * template flow, whose game choice MUST succeed for step 2 to load templates.
   */
  async selectGameResilient(name: string): Promise<void> {
    const re = new RegExp(name, 'i');
    await expect(async () => {
      await this.searchGames(name); // re-type to (re)trigger the hosted search
      const option = this.gameOption(re).first();
      await expect(option).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
      await option.click();
      await expect(this.field('external_game_id')).toHaveValue(re, {
        timeout: UI_ACTION_TIMEOUT_MS,
      });
    }).toPass({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /** Assert a wizard advance button is enabled (fail fast) and click it. */
  private async advance(label: string | RegExp, step: string, exact = false): Promise<void> {
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
    // Step 1 "Choose name and Game": name the server AND pick a game. A game
    // selection is REQUIRED to advance — the game field registers external_game_id
    // in the page-validity gate and stays touched=false until an item is selected,
    // so "Next Step" is disabled until then (naming alone never enables it).
    await this.typeInto(this.field('server_name'), opts.serverName, 'server name');
    await this.selectGenericGame();
    await this.advance('Next Step', 'step 1 (name/game)');

    // Step 2 "Choose Template": a generic game has no templates → continue without one.
    await this.advance('Continue without Template', 'step 2 (template)');

    // Step 3 "Configure your Server": custom Docker image + RAM limit (+ volume).
    await this.typeInto(this.field('docker_image_name'), opts.dockerImage, 'docker image');
    // The tag field defaults to "latest"; only override when a different tag is asked for.
    if (opts.imageTag && opts.imageTag !== 'latest') {
      await this.typeInto(this.field('docker_image_tag'), opts.imageTag, 'image tag');
    }
    await this.setMemoryLimit(opts.memoryLimit);
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
    // Released label is "Go to dashboard" (main used "Open Dashboard").
    await success.getByRole('button', { name: /Go to dashboard|Open Dashboard/ }).click();
  }

  // ── Step 1/2: game catalog & template inspection (templates / games-search) ──
  //
  // The released wizard's game picker IS the step-1 `#external_game_id`
  // autocomplete (opened by clicking the field; typing filters it). There is no
  // separate "Search games..." sidebar on release 5dba6e8, so these catalog
  // helpers drive the SAME control the creation flow uses — keeping the extended
  // catalog specs consistent with main's corrected wizard rather than forking a
  // second UI model. Templates live on step 2 ("Choose Template"), reached via
  // "Next Step" once step 1 is valid (name + game). Exact option/artwork DOM is
  // best-effort and may need CI selector tuning against the live catalog.

  /** A game option row in the step-1 autocomplete popover (name = game label). */
  private gameOption(name: string | RegExp): Locator {
    // TODO(testid): add data-testid={`game-option-${slug}`} to the AutoComplete row
    return this.page.getByRole('option', { name });
  }

  /**
   * The step-2 template list. Verified against released `TemplateList.tsx` (5dba6e8):
   * a `<div role="listbox">` of `<Card role="option">` entries — so the role-based
   * locator IS the real structure. Note Step2 renders a DIFFERENT branch entirely
   * (a "No templates are available for this game." paragraph, no listbox at all)
   * whenever `templatesForGame` is empty — which is also the state while the
   * templates redux slice is still being fetched. Hence {@link waitForTemplateOptions}.
   */
  private get templateList(): Locator {
    return this.dialog.getByRole('listbox');
  }

  /** Step-2's empty/short-circuit branch (rendered instead of the listbox). */
  private get noTemplatesMessage(): Locator {
    return this.dialog.getByText(/No templates are available for this game/i);
  }

  /**
   * Wait for step 2 to actually offer templates, tolerating the slice still loading.
   * `templatesForGame` filters the templates redux slice by the selected game, and
   * until that fetch resolves the list is empty → Step2 renders the
   * "No templates are available" branch (no listbox), then re-renders once the
   * templates arrive. So a short wait can observe the empty branch and give up. Poll
   * generously, and if we still end on the empty branch say so precisely — that
   * distinguishes "hosted template API returned nothing for this game" from "the
   * option locator is wrong".
   */
  private async waitForTemplateOptions(): Promise<void> {
    const option = this.templateList.getByRole('option').first();
    try {
      await expect(option).toBeVisible({ timeout: UI_FLOW_TIMEOUT_MS });
    } catch (e) {
      if (await this.noTemplatesMessage.isVisible().catch(() => false)) {
        throw new Error(
          'step 2: the wizard reports "No templates are available for this game" — the ' +
            'templates slice loaded but contained no template matching the selected ' +
            "game's id (hosted template API empty/unreachable, or a game↔template id " +
            'mismatch). This is NOT a selector problem: TemplateList renders ' +
            'role=listbox/role=option when it has templates.',
          { cause: e },
        );
      }
      await this.throwIfCrashed('waiting for the step-2 template list');
      throw new Error(
        'step 2: no template options appeared and the "no templates" message was not ' +
          'shown either — the template list never rendered.',
        { cause: e },
      );
    }
  }

  /**
   * Filter the game catalog by typing into the `#external_game_id` autocomplete
   * at human cadence (the field is a controlled input — a single-event fill()
   * would not commit; see the module header).
   */
  async searchGames(query: string): Promise<void> {
    const game = this.field('external_game_id');
    await game.click();
    await game.press('ControlOrMeta+a');
    await game.press('Delete');
    await game.pressSequentially(query, { delay: KEYSTROKE_DELAY_MS });
  }

  /** Assert a game is offered in the catalog (case-insensitive on its name). */
  async expectGameOffered(name: string): Promise<void> {
    await this.field('external_game_id').click(); // open the popover
    await expect(this.gameOption(new RegExp(name, 'i')).first()).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  /**
   * Retry-tolerant "game is offered" check for the flaky hosted games API. The
   * autocomplete queries cosy-game-api (SteamGridDB proxy), which under the catalog
   * spec's multiple searches can be eventually-consistent / rate-limited, so a game
   * that `games-search` finds may momentarily not appear here. Re-type the query to
   * re-trigger the hosted search and retry until the option shows, within a generous
   * budget — proving the catalog is reachable without flaking on transient misses.
   */
  async expectGameOfferedResilient(name: string): Promise<void> {
    await expect(async () => {
      await this.searchGames(name); // re-type to (re)trigger the hosted search
      await expect(this.gameOption(new RegExp(name, 'i')).first()).toBeVisible({
        timeout: UI_ACTION_TIMEOUT_MS,
      });
    }).toPass({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Assert the search returns a matching game result. Proves the hosted game-service
   * path (backend → cosy-game-api → SteamGridDB) is reachable and the query returns
   * the expected game as a selectable option. Call {@link searchGames} first so the
   * popover is open + filtered. Uses a generous timeout because the hosted API is on
   * the critical path.
   *
   * NOTE: the released wizard's game option (5dba6e8, `AutoCompleteItemList` /
   * `Step1.mapGamesDtoToAutoCompleteItems`) renders ONLY the game name + template
   * count — it sets no `leftSlot`, so there is no artwork `<img>` to assert on. See
   * docs/KNOWN-ISSUES.md ("game search list surfaces no artwork").
   */
  async expectGameResult(name: string): Promise<void> {
    await expect(this.gameOption(new RegExp(name, 'i')).first()).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }

  /**
   * Advance from a chosen game (step 1) to "Choose Template" (step 2) and assert
   * at least one template option is offered — proof the hosted catalog loaded.
   * A server name is required for step 1 to validate, so a throwaway one is
   * entered if the caller has not set it (catalog specs only care about step 2).
   */
  async expectTemplateOptionsPresent(): Promise<void> {
    const nameField = this.field('server_name');
    if (!(await nameField.inputValue().catch(() => ''))) {
      await this.typeInto(nameField, `catalog-check-${Date.now()}`, 'server name');
    }
    await this.advance('Next Step', 'step 1 (name/game)');
    await this.waitForTemplateOptions();
  }

  /**
   * Fill a step-2 template-variable input (id=placeholder) at human cadence, if the
   * selected template exposes it. The variable inputs mount a render tick AFTER the
   * template card is clicked (React commits the selection → TemplateVariableForm
   * renders `#version` / `#memory` / …), so an instantaneous check races that render
   * and skips the field. Skipping a REQUIRED variable is fatal: e.g. the PaperMC
   * template's `version` has no default, so an unfilled `version` keeps
   * `validateTemplateVariables` false and the step-2 advance ("Apply Template")
   * permanently disabled. Wait for the input before concluding the template lacks it.
   */
  private async typeTemplateVariable(id: string, value: string): Promise<void> {
    const input = this.field(id);
    try {
      await input.waitFor({ state: 'visible', timeout: UI_ACTION_TIMEOUT_MS });
    } catch {
      return; // this template genuinely has no such variable
    }
    await this.typeInto(input, value, `template variable ${id}`);
  }

  /**
   * Full "create from a hosted catalog template" flow (the server-from-template
   * feature), built on the corrected step primitives (typeInto / selectGame /
   * typeTemplateVariable / advance + crash detector):
   *   Step 1 "Choose name and Game" — server name + the REAL game, "Next Step".
   *   Step 2 "Choose Template"       — select the template, fill its required
   *                                    variables, "Apply Template".
   *   Step 3 "Configure your Server" — image/memory PREFILLED by the template, so the
   *                                    step is already valid → "Create Server" → confirm.
   * Leaves the success dialog open (caller opens the server via {@link openCreatedServer}).
   *
   * The game MUST be a real SteamGridDB-backed catalog game (the step-1 autocomplete
   * queries the games API, which is DISJOINT from the template service — a template
   * whose game has no games-API presence is unreachable in the wizard). Minecraft is
   * such a game and its image is already pulled by the `rcon` fixture (shared layers).
   */
  async createFromCatalogTemplate(opts: {
    serverName: string;
    /** Step-1 game name to select so its templates load in step 2 (e.g. "minecraft"). */
    game: string;
    /** Step-2 template option to pick (e.g. /paper/i). */
    template: string | RegExp;
    /** Required template-variable inputs to fill (id=placeholder → value). */
    templateVariables?: Record<string, string>;
    /** Optional: assert step-3's docker image was prefilled from the template. */
    expectImagePrefill?: string | RegExp;
  }): Promise<void> {
    // Step 1 — name the server AND select the real game so its templates load in
    // step 2. Selecting the game is REQUIRED to advance; select it resiliently since
    // the hosted games API can be slow/empty on the first query.
    await this.typeInto(this.field('server_name'), opts.serverName, 'server name');
    await this.selectGameResilient(opts.game);
    await this.advance('Next Step', 'step 1 (name/game)');

    // Step 2 — pick the catalog template, then fill its required variables. Once a
    // template is selected the advance reads "Apply Template" (vs "Continue without
    // Template") and only enables when validateTemplateVariables passes.
    await this.waitForTemplateOptions();
    await this.templateList.getByRole('option', { name: opts.template }).first().click();
    for (const [id, value] of Object.entries(opts.templateVariables ?? {})) {
      await this.typeTemplateVariable(id, value);
    }
    await this.advance(/Apply Template|Next Step|Continue/, 'step 2 (template)');

    // Step 3 — the template applied its docker image + memory into the form state, so
    // the step is already valid; create without editing.
    if (opts.expectImagePrefill !== undefined) {
      await expect(
        this.field('docker_image_name'),
        'step 3: template did not prefill the docker image',
      ).toHaveValue(opts.expectImagePrefill, { timeout: UI_ACTION_TIMEOUT_MS });
    }
    await this.advance('Create Server', 'step 3 (configure)', true);

    const confirm = this.page.getByRole('alertdialog');
    await expect(confirm).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await confirm.getByRole('button', { name: 'Create Server', exact: true }).click();
  }
}
