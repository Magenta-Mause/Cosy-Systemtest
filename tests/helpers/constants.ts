/**
 * Single source of truth for the target URL and every timeout budget.
 *
 * Timeouts are deliberately generous: a GitHub-hosted runner installs the whole
 * Cosy stack from scratch and then pulls/starts a real game-server container, so
 * anything CPU- or network-bound needs headroom to avoid flaky failures (a lesson
 * carried over from the domain-provider suite, whose tight defaults flaked for
 * months). Bump the constant here, never sprinkle magic numbers into specs.
 */

/** Default target — the port the systemtest workflow installs Cosy on. */
export const DEFAULT_BASE_URL = 'http://localhost:8080';

/**
 * Resolve the target base URL. The only place `COSY_BASE_URL` is read; specs and
 * page objects use relative paths against `use.baseURL`.
 */
export function resolveBaseURL(): string {
  return process.env.COSY_BASE_URL ?? DEFAULT_BASE_URL;
}

/** Backend context path — every REST endpoint is served under `/api`. */
export const API_CONTEXT_PATH = '/api';

/** Actuator health endpoint (relative to the base URL). */
export const HEALTH_PATH = `${API_CONTEXT_PATH}/actuator/health`;

// ── Timeout budgets ─────────────────────────────────────────────────────────

/** A single UI interaction / assertion (click, fill, expect-visible). */
export const UI_ACTION_TIMEOUT_MS = 15_000;

/** UI login round-trip (submit → refresh identity token → dialog closes). */
export const LOGIN_TIMEOUT_MS = 30_000;

/**
 * Cold server start: pull the image + start the container + reach RUNNING.
 * `halftheopposite/tosios` is small, but a cold Docker pull on a fresh runner
 * plus scheduling still wants a wide budget.
 */
export const SERVER_START_TIMEOUT_MS = 120_000;

/**
 * Generous start budget for a server whose start competes for host resources. The
 * async start goes STOPPED → AWAITING_UPDATE → (PULLING_IMAGE) → RUNNING, and a cold
 * pull plus scheduling on a 4-vCPU runner can outlast the standard 120 s budget.
 * `ApiClient.ensureRunning` / `waitUntilStartable` use this as their default, and the
 * UI "reaches RUNNING" waits reuse it.
 *
 * NOTE: a server parked in AWAITING_UPDATE is NOT, by itself, evidence of pull
 * contention — that was the working theory until run 18 reproduced it with a serial
 * run, no Minecraft and the image already local. The real cause is the backend losing
 * its Docker event stream, which no timeout can outlast; `EVENT_STREAM_WEDGE_GRACE_MS`
 * detects it and fails fast rather than spending this budget. See docs/KNOWN-ISSUES.md
 * ("backend loses the Docker event stream").
 */
export const SERVER_COLD_START_TIMEOUT_MS = 300_000;

/** Server stop → STOPPED transition. */
export const SERVER_STOP_TIMEOUT_MS = 60_000;

/**
 * Time to wait for a live message to arrive over the WebSocket (a status update
 * reflected in the UI, or the first console log line).
 */
export const WS_MESSAGE_TIMEOUT_MS = 30_000;

/** Poll interval when waiting for an async server-status transition via the API. */
export const STATUS_POLL_INTERVAL_MS = 2_000;

/**
 * Prefix Cosy gives game-server containers (`cosy-<uuid>`) — backend default
 * `COSY_DOCKER_CONTAINER_PREFIX`, which the compose install does not override.
 * Used only by the read-only Docker probe in `helpers/docker.ts`.
 */
export const GAME_SERVER_CONTAINER_PREFIX = 'cosy-';

/**
 * Grace period before a *transitional* status (AWAITING_UPDATE / STOPPING) that
 * disagrees with the real container state is called a WEDGE rather than slowness.
 *
 * The disagreement itself is already unambiguous — a running container whose server
 * still reports AWAITING_UPDATE means the backend never received the Docker `start`
 * event — but the event and our poll can legitimately cross in flight for a moment.
 * 45 s is orders of magnitude more than that race needs while still collapsing a
 * wedged 300 s × 3-retry black hole (run 18 burned ~46 min and got the job cancelled
 * at its 60-minute budget) into a fast, precisely-named failure.
 */
export const EVENT_STREAM_WEDGE_GRACE_MS = 45_000;

/** How long the API client waits for a game-server to reach a target status. */
export const STATUS_POLL_TIMEOUT_MS = SERVER_START_TIMEOUT_MS;

// ── Fixtures / shared test data ─────────────────────────────────────────────

/**
 * Dummy-data image shipped by Cosy for exactly this purpose: it starts in seconds
 * and stays small. Used by the create/lifecycle/console/files specs.
 */
export const TOSIOS_IMAGE = 'halftheopposite/tosios';

/**
 * Memory limit requested for the shared test server. Cosy stores the limit as a
 * unit-suffixed string (e.g. "512MiB", "1GiB") — see `docker_memory_limit` on
 * DockerHardwareLimits and the frontend `formatMemoryLimit` util.
 */
export const TEST_SERVER_MEMORY_LIMIT = '512MiB';

/** Name of the server reused across lifecycle/console/files (get-or-create). */
export const SHARED_SERVER_NAME = 'systemtest-tosios';

// ── Phase 2: extended feature budgets & data ────────────────────────────────

/**
 * Historical logs are Loki-backed, and Loki ingestion lags the live stream by a
 * few seconds. `logs-history` polls the history view for up to this long before
 * giving up (generous — a fresh runner's Loki can be slow to flush).
 */
export const LOGS_HISTORY_TIMEOUT_MS = 90_000;

/**
 * Metrics are InfluxDB-backed and only accrue once the container has been running
 * long enough to emit a couple of scrape periods (custom-metrics period is 2 s).
 * The `metrics` spec polls the dashboard for rendered data points for up to this
 * long.
 */
export const METRICS_RENDER_TIMEOUT_MS = 120_000;

/**
 * Minecraft (itzg/PaperMC) readiness in the `rcon` fixture: image pull + boot + world
 * gen until the server is RUNNING and logs "Done". BOUNDED at 7 min (not the old
 * 12 min): a healthy 1 GiB Paper boot on the runner completes well within this, and
 * if the server is genuinely stuck (image-pull stall → AWAITING_UPDATE, or an OOM
 * crash loop), ensureRunning throws cleanly with the last status at ~7 min instead of
 * burning the full test timeout with no diagnosis. See docs/KNOWN-ISSUES.md.
 */
export const MINECRAFT_READY_TIMEOUT_MS = 420_000;

/** How long to wait for an RCON command's response line to appear in the console. */
export const RCON_RESPONSE_TIMEOUT_MS = 45_000;

/** How long to wait for the local webhook sink to receive a delivered event. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 60_000;

/** A short-lived UI flow that provisions data (invite redeem, role change, etc.). */
export const UI_FLOW_TIMEOUT_MS = 60_000;

/**
 * Minecraft template identity. The single-host compose install points the backend
 * at the HOSTED template/game APIs (see the templates/games-search spec comments),
 * whose catalog exposes `minecraft` as a game id (Cosy-templates
 * templates/minecraft/vanilla.yaml → game_id: minecraft, image itzg/minecraft-server).
 */
export const MINECRAFT_GAME_ID = 'minecraft';
export const MINECRAFT_IMAGE = 'itzg/minecraft-server';

/**
 * Container memory LIMIT (Docker `--memory`) for the Minecraft run — must exceed the
 * JVM heap (MINECRAFT_JVM_MEMORY) or the container OOM-kills before the world is ready.
 */
export const MINECRAFT_MEMORY_GIB = '2';

/**
 * JVM heap for the itzg server (`MEMORY` env → -Xms/-Xmx). Kept at 1 GiB — WELL BELOW
 * the 2 GiB container limit above. The heap plus JVM overhead (metaspace, thread
 * stacks, direct buffers, GC) must fit inside the container limit; setting the heap
 * equal to the limit (the previous "2G" with a 2GiB container) risks an OOM-kill loop
 * that leaves the server never reaching a stable RUNNING — the likely cause of the
 * rcon fixture never becoming ready. 1 GiB boots a fresh Paper world fine.
 */
export const MINECRAFT_JVM_MEMORY = '1G';

/** Games known to exist in the hosted catalog (Cosy-templates/templates/*). */
export const KNOWN_TEMPLATE_GAMES = ['minecraft', 'terraria', 'cs2', 'palworld', 'ark'] as const;

/** Shared server name reused by the extended specs that need a running server. */
export const SHARED_MINECRAFT_NAME = 'systemtest-minecraft';

/**
 * RCON wiring for the itzg Minecraft server. The vanilla Cosy template
 * (Cosy-templates/templates/minecraft/vanilla.yaml) does NOT wire RCON env vars,
 * so the itzg image defaults apply (RCON enabled, port 25575). To make RCON
 * deterministically testable we create the shared Minecraft server with an
 * explicit RCON password/port via `environment_variables`, then configure Cosy's
 * RCON with the SAME values so Cosy can connect and relay `list` back to the
 * console.
 */
export const MINECRAFT_RCON_PORT = 25575;
export const MINECRAFT_RCON_PASSWORD = 'systemtest-rcon';

/**
 * Base env for the itzg Minecraft server created over the API (the fixture path).
 * `EULA=true` is mandatory or itzg refuses to start; RCON_* make RCON testable.
 * (The template path sets EULA via the template's own env.)
 *
 * TYPE is PAPER, not VANILLA: on a 4-vCPU GitHub runner, vanilla world generation
 * routinely overran the ready budget (the first full run took ~30 min with retries
 * and still failed to reach RUNNING). PaperMC is a drop-in vanilla-compatible server
 * that generates a world far faster while supporting the same RCON `list` command,
 * so it boots reliably within budget. See docs/KNOWN-ISSUES.md.
 */
export const MINECRAFT_ENV: Record<string, string> = {
  EULA: 'true',
  TYPE: 'PAPER',
  // JVM heap (1G) deliberately BELOW the 2GiB container limit — see MINECRAFT_JVM_MEMORY.
  MEMORY: MINECRAFT_JVM_MEMORY,
  ENABLE_RCON: 'true',
  RCON_PORT: String(MINECRAFT_RCON_PORT),
  RCON_PASSWORD: MINECRAFT_RCON_PASSWORD,
};
