import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  SERVER_START_TIMEOUT_MS,
  UI_ACTION_TIMEOUT_MS,
  UI_FLOW_TIMEOUT_MS,
} from '@helpers/constants';

/**
 * The three-step create-server wizard, derived from the RELEASED frontend
 * (revision 2659b07, the image pinned by installer v1.1.0):
 *   Step 1 "Choose a Game & Template" — game sidebar + template browser
 *   Step 2 "Choose Template"          — server name + the template's variables
 *   Step 3 "Configure your Server"    — Docker image (+ RAM, + optional volume) →
 *                                       "Create Server" → confirm dialog
 *
 * THE STEPS WERE RESHUFFLED IN v1.1.0. On v1.0.3 step 1 was "name + game" and step 2
 * was the template list; now BOTH the game and the template are chosen on step 1, and
 * the server name moved to step 2. Anything that used to advance from step 1 to reach
 * the templates now finds them without advancing at all. The step-2 label still reads
 * "Choose Template" — that is stale copy in the product, not a mistake here.
 *
 * The game picker is a SIDEBAR of buttons with a "Search games..." box, not the old
 * `#external_game_id` autocomplete (which no longer exists). Its always-present first
 * entry is "Generic Server" (v1.0.3 called it "Generic Game"). Selecting a game only
 * changes CSS classes — there is no aria-selected — so selection is confirmed
 * behaviourally, by waiting for the template pane to re-render.
 *
 * Clicking a template card ADVANCES to step 2 by itself (`handleTemplateSelected`);
 * the Next button is only needed for the no-template path.
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
 * SELECTORS: v1.1.0 ships data-testids for the wizard's load-bearing controls
 * (`create-server-next-btn`, `create-field-*`, `create-confirm-btn`,
 * `create-success-open-dashboard-btn`) and they are used here. The advance button is
 * addressed by testid rather than by label ON PURPOSE: since v1.1.0 a loading Button
 * REPLACES its children with a loading label, so `getByRole('button', {name: 'Create
 * Server'})` stops matching the moment it is clicked. Controls with no testid yet
 * (sidebar games, template cards, the memory unit select, list-input rows) keep
 * role/id selectors and are logged in docs/testid-gaps.md.
 */
// Type at a human cadence, not machine speed: verified locally (released frontend,
// dev + prod builds, real dialog with/without data) that both fast and 60ms-delayed
// keystrokes persist the controlled-input value without crashing. A user-like delay
// is the realistic write and costs a fraction of a second.
const KEYSTROKE_DELAY_MS = 60;

/** Step-1 sidebar label for the always-present no-game entry (was "Generic Game" on v1.0.3). */
const GENERIC_GAME_LABEL = 'Generic Server';

/**
 * Both "nothing to choose here" branches of the template pane. Step 1's
 * TemplateBrowser says "No templates available for this game."; step 2 says "No
 * templates are available for this game. You can proceed." One regex covers both.
 */
const NO_TEMPLATES_RE = /No templates (are )?available for this game/i;

export class CreateServerPage {
  /** Set if a React "maximum update depth"/#185 error is observed on the page. */
  private reactCrash: string | null = null;

  constructor(private readonly page: Page) {
    // The create wizard has been seen to blank out with React #185 (maximum update
    // depth) during the create flow in CI. Capture it so a crash surfaces as a clear,
    // truthful failure instead of a misleading "value did not persist" (the input
    // vanishes when the app unmounts). See docs/KNOWN-ISSUES.md.
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

  /**
   * A wizard input by its `create-field-<attribute>` testid. Only the attributes that
   * render through GenericGameServerCreationInputField (plus the memory widget) carry
   * one: server_name, docker_image_name, docker_image_tag, execution_command,
   * docker_max_memory. List-style inputs do NOT — use {@link legacyField} for those.
   */
  private field(attribute: string): Locator {
    return this.dialog.getByTestId(`create-field-${attribute}`);
  }

  /** An input that still has only a DOM id (no testid yet) — e.g. docker_max_cpu. */
  private legacyField(id: string): Locator {
    return this.dialog.locator(`#${id}`);
  }

  /** The wizard's single advance button (label varies by step and by loading state). */
  private get nextButton(): Locator {
    return this.dialog.getByTestId('create-server-next-btn');
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
        `Create wizard CRASHED while ${during}: the app unmounted ` +
          `(${this.reactCrash ? `React "${this.reactCrash.split('\n')[0]}"` : 'page blanked out'}). ` +
          `This is a product defect surfaced by the systemtest — the create feature is ` +
          `genuinely broken in that run. See docs/KNOWN-ISSUES.md.`,
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
   * pick it from the select. The `create-field-docker_max_memory` testid is passed
   * through MemoryLimitInput onto the NUMERIC input; the unit select has none.
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

  // ── Step 1: game sidebar & template browser ────────────────────────────────

  /** A game entry in the step-1 sidebar (a button holding artwork + name + count). */
  private gameOption(name: string | RegExp): Locator {
    // TODO(testid): add data-testid={`game-option-${slug}`} to GameSidebar's SidebarItem
    return this.dialog.getByRole('button', { name });
  }

  /**
   * The step-1 template pane. `TemplateList` renders a `<div role="listbox">` of
   * `<Card role="option">` entries, so the role-based locator IS the real structure.
   * When the selected game has no templates the browser renders a plain message
   * INSTEAD of the listbox — see {@link NO_TEMPLATES_RE} and
   * {@link waitForTemplateOptions}.
   */
  private get templateList(): Locator {
    return this.dialog.getByRole('listbox');
  }

  /** The template pane's empty/short-circuit branch (rendered instead of the listbox). */
  private get noTemplatesMessage(): Locator {
    return this.dialog.getByText(NO_TEMPLATES_RE);
  }

  /**
   * Filter the game sidebar by typing into its "Search games..." box at human cadence
   * (controlled input — a single-event fill() would not commit; see the module header).
   */
  async searchGames(query: string): Promise<void> {
    const search = this.dialog.getByPlaceholder('Search games...');
    await search.click();
    await search.press('ControlOrMeta+a');
    await search.press('Delete');
    await search.pressSequentially(query, { delay: KEYSTROKE_DELAY_MS });
  }

  /**
   * Select a game in the step-1 sidebar. Selecting a game is what filters the template
   * browser to that game's templates, which is the whole template-creation path.
   *
   * The sidebar signals selection with CSS classes only (no aria-selected/aria-current),
   * so instead of asserting on styling we confirm behaviourally: the template pane must
   * settle into one of its two real states (a listbox, or the "no templates" message).
   */
  async selectGame(
    name: string | RegExp,
    opts: { notFound?: string } = {},
  ): Promise<void> {
    const option = this.gameOption(name).first();
    await expect(
      option,
      opts.notFound ?? `step 1: game "${name}" was not offered in the game sidebar`,
    ).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    await option.click();
    await expect(this.templateList.or(this.noTemplatesMessage).first()).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }

  /**
   * Select the always-present generic entry so no template is applied: step 3's Docker
   * image stays empty and editable, keeping a clean path to a custom image. It is
   * rendered client-side, so it works even if the hosted games API is unreachable.
   */
  private async selectGenericGame(): Promise<void> {
    await this.selectGame(GENERIC_GAME_LABEL, {
      notFound: `step 1: the "${GENERIC_GAME_LABEL}" sidebar entry never appeared`,
    });
  }

  /**
   * Select a game resiliently against the flaky hosted games API (cosy-game-api /
   * SteamGridDB): the first query can return empty / be slow / be rate-limited, so
   * re-type the search and retry the whole selection within a generous budget.
   */
  async selectGameResilient(name: string): Promise<void> {
    const re = new RegExp(name, 'i');
    await expect(async () => {
      await this.searchGames(name); // re-type to (re)trigger the hosted search
      await this.selectGame(re);
    }).toPass({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /** Assert a game is offered in the catalog (case-insensitive on its name). */
  async expectGameOffered(name: string): Promise<void> {
    await this.searchGames(name);
    await expect(this.gameOption(new RegExp(name, 'i')).first()).toBeVisible({
      timeout: UI_ACTION_TIMEOUT_MS,
    });
  }

  /**
   * Retry-tolerant "game is offered" check for the flaky hosted games API. The sidebar
   * is populated from cosy-game-api (SteamGridDB proxy), which under the catalog spec's
   * repeated searches can be eventually-consistent / rate-limited, so a game that
   * `games-search` finds may momentarily not appear here. Re-type the query to
   * re-trigger the hosted search and retry within a generous budget — proving the
   * catalog is reachable without flaking on transient misses.
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
   * the expected game as a selectable entry. Call {@link searchGames} first.
   *
   * Since v1.1.0 the sidebar DOES render game artwork (`GameSidebar` shows
   * `game.logo_url`, falling back to a console icon), unlike v1.0.3 which rendered
   * name + template count only. The `<img>` carries `alt=""`, so it is invisible to
   * accessible-name matching and must be asserted structurally — see
   * {@link expectGameArtwork}.
   */
  async expectGameResult(name: string): Promise<void> {
    await expect(this.gameOption(new RegExp(name, 'i')).first()).toBeVisible({
      timeout: UI_FLOW_TIMEOUT_MS,
    });
  }

  /**
   * Assert a game entry renders real artwork from the games API rather than the local
   * fallback icon. `alt=""` is deliberate (decorative), so match the `<img>` itself.
   */
  async expectGameArtwork(name: string): Promise<void> {
    const artwork = this.gameOption(new RegExp(name, 'i')).first().locator('img');
    await expect(
      artwork,
      `game "${name}" rendered no artwork <img> — the games API returned no logo_url, ` +
        `so the sidebar fell back to the local console icon`,
    ).toBeVisible({ timeout: UI_FLOW_TIMEOUT_MS });
  }

  /**
   * Wait for the template pane to actually offer templates, tolerating the slice still
   * loading. `templateMatchesGame` filters the templates redux slice by the selected
   * game, and until that fetch resolves the list is empty → the browser renders the
   * "No templates available" branch (no listbox), then re-renders once the templates
   * arrive. So a short wait can observe the empty branch and give up. Poll generously,
   * and if we still end on the empty branch say so precisely — that distinguishes
   * "hosted template API returned nothing for this game" from "the locator is wrong".
   */
  private async waitForTemplateOptions(): Promise<void> {
    const option = this.templateList.getByRole('option').first();
    try {
      await expect(option).toBeVisible({ timeout: UI_FLOW_TIMEOUT_MS });
    } catch (e) {
      if (await this.noTemplatesMessage.isVisible().catch(() => false)) {
        throw new Error(
          'step 1: the wizard reports "No templates available for this game" — the ' +
            'templates slice loaded but contained no template matching the selected ' +
            "game (hosted template API empty/unreachable, or `templateMatchesGame` no " +
            'longer matches the template\'s game_id slug against the game). This is NOT ' +
            'a selector problem: TemplateList renders role=listbox/role=option when it ' +
            'has templates. NOTE: on v1.0.3 this message was the KNOWN product bug ' +
            '(string game_id vs numeric external_game_id); v1.1.0 fixed it, so seeing ' +
            'it now is a regression.',
          { cause: e },
        );
      }
      await this.throwIfCrashed('waiting for the step-1 template list');
      throw new Error(
        'step 1: no template options appeared and the "no templates" message was not ' +
          'shown either — the template list never rendered.',
        { cause: e },
      );
    }
  }

  /**
   * Assert the step-1 template browser offers at least one template for the
   * already-selected game — proof the hosted catalog loaded.
   *
   * On v1.0.3 this had to advance past step 1 first; since v1.1.0 the templates live
   * on step 1 next to the game sidebar, so no advance is needed.
   */
  async expectTemplateOptionsPresent(): Promise<void> {
    await this.waitForTemplateOptions();
  }

  // ── Advancing ──────────────────────────────────────────────────────────────

  /**
   * Assert the wizard's advance button is enabled (fail fast) and click it.
   *
   * Addressed by testid, never by label: the button's text changes per step
   * ("Continue without Template" / "Apply Template" / "Create Server") AND is replaced
   * by a loading label while a request is in flight. `expectedLabel` is asserted
   * separately so a step-order regression still fails loudly with a readable message.
   */
  private async advance(
    step: string,
    opts: { expectedLabel?: string | RegExp } = {},
  ): Promise<void> {
    const btn = this.nextButton;
    try {
      await expect(btn).toBeEnabled({ timeout: UI_ACTION_TIMEOUT_MS });
    } catch (e) {
      await this.throwIfCrashed(`advancing past ${step}`);
      throw new Error(
        `${step}: the advance button never became enabled — wizard step validation was ` +
          `not satisfied (a required controlled input did not register as touched+valid, ` +
          `or a required template variable is unfilled).`,
        { cause: e },
      );
    }
    if (opts.expectedLabel !== undefined) {
      await expect(
        btn,
        `${step}: the advance button read something unexpected — the wizard is probably ` +
          `not on the step this helper thinks it is on`,
      ).toHaveText(opts.expectedLabel, { timeout: UI_ACTION_TIMEOUT_MS });
    }
    await btn.click();
  }

  // ── Full flows ─────────────────────────────────────────────────────────────

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
    // Step 1 "Choose a Game & Template": take the generic entry so no template is
    // applied and step 3's docker image stays ours. Step 1 is always valid, so the
    // advance button is enabled immediately and reads "Continue without Template".
    await this.selectGenericGame();
    await this.advance('step 1 (game/template)', {
      expectedLabel: /Continue without Template/i,
    });

    // Step 2 "Choose Template": on v1.1.0 this step holds the SERVER NAME (and any
    // template variables — none here, since no template was applied).
    await this.typeInto(this.field('server_name'), opts.serverName, 'server name');
    await this.advance('step 2 (name)', { expectedLabel: /Continue without Template/i });

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
    await this.advance('step 3 (configure)', { expectedLabel: /Create Server/i });

    await this.confirmCreate();
  }

  /**
   * Full "create from a hosted catalog template" flow (the server-from-template
   * feature):
   *   Step 1 — select the REAL game in the sidebar, then click its template card
   *            (which advances to step 2 by itself).
   *   Step 2 — server name + the template's required variables → "Apply Template".
   *   Step 3 — image/memory PREFILLED by the template, so the step is already valid
   *            → "Create Server" → confirm.
   * Leaves the success dialog open (caller opens the server via {@link openCreatedServer}).
   *
   * The game MUST be a real SteamGridDB-backed catalog game: the sidebar is populated
   * from the games API, which is DISJOINT from the template service, so a template
   * whose game has no games-API presence is unreachable in the wizard. Minecraft is
   * such a game and its image is already pulled by the `rcon` fixture (shared layers).
   */
  async createFromCatalogTemplate(opts: {
    serverName: string;
    /** Step-1 sidebar game to select so its templates are listed (e.g. "minecraft"). */
    game: string;
    /** Step-1 template card to pick (e.g. /paper/i). */
    template: string | RegExp;
    /** Required template-variable inputs to fill (id=placeholder → value). */
    templateVariables?: Record<string, string>;
    /** Optional: assert step-3's docker image was prefilled from the template. */
    expectImagePrefill?: string | RegExp;
  }): Promise<void> {
    // Step 1 — select the real game resiliently (the hosted games API can be slow or
    // empty on the first query), then pick the template. Clicking a template card
    // advances to step 2 on its own, so no advance() call belongs here.
    await this.selectGameResilient(opts.game);
    await this.waitForTemplateOptions();
    await this.templateList.getByRole('option', { name: opts.template }).first().click();

    // Step 2 — name the server, then fill the template's required variables. The
    // advance reads "Apply Template" once a template is selected and only enables when
    // validateTemplateVariables passes (every variable is required).
    await this.typeInto(this.field('server_name'), opts.serverName, 'server name');
    for (const [id, value] of Object.entries(opts.templateVariables ?? {})) {
      await this.typeTemplateVariable(id, value);
    }
    await this.advance('step 2 (name/template variables)', {
      expectedLabel: /Apply Template/i,
    });

    // Step 3 — the template applied its docker image + memory into the form state, so
    // the step is already valid; create without editing.
    if (opts.expectImagePrefill !== undefined) {
      await expect(
        this.field('docker_image_name'),
        'step 3: template did not prefill the docker image',
      ).toHaveValue(opts.expectImagePrefill, { timeout: UI_ACTION_TIMEOUT_MS });
    }
    await this.advance('step 3 (configure)', { expectedLabel: /Create Server/i });

    await this.confirmCreate();
  }

  /**
   * Fill a step-2 template-variable input (id=placeholder) at human cadence, if the
   * selected template exposes it. The variable inputs mount a render tick AFTER the
   * template card is clicked (React commits the selection → TemplateVariableForm
   * renders `#version` / `#memory` / …), so an instantaneous check races that render
   * and skips the field. Skipping a variable is fatal: since v1.1.0 EVERY template
   * variable is required (`isRequired: true` for all of them), so an unfilled one
   * keeps `validateTemplateVariables` false and the step-2 advance permanently
   * disabled. Wait for the input before concluding the template lacks it.
   */
  private async typeTemplateVariable(id: string, value: string): Promise<void> {
    const input = this.legacyField(id);
    try {
      await input.waitFor({ state: 'visible', timeout: UI_ACTION_TIMEOUT_MS });
    } catch {
      return; // this template genuinely has no such variable
    }
    await this.typeInto(input, value, `template variable ${id}`);
  }

  /** Accept the final "Create Server?" confirmation dialog. */
  private async confirmCreate(): Promise<void> {
    const confirm = this.page.getByRole('alertdialog');
    await expect(confirm).toBeVisible({ timeout: UI_ACTION_TIMEOUT_MS });
    // By testid, not label: the button's text flips to "Creating..." once clicked.
    await confirm.getByTestId('create-confirm-btn').click();
  }

  /** Wait for the success dialog and open the created server's dashboard. */
  async openCreatedServer(): Promise<void> {
    const success = this.page.getByRole('dialog').filter({ hasText: 'Server Created!' });
    await expect(success).toBeVisible({ timeout: SERVER_START_TIMEOUT_MS });
    // Visible label is "Go to dashboard"; the testid says open-dashboard.
    await success.getByTestId('create-success-open-dashboard-btn').click();
  }
}
