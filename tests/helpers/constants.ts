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

/** Server stop → STOPPED transition. */
export const SERVER_STOP_TIMEOUT_MS = 60_000;

/**
 * Time to wait for a live message to arrive over the WebSocket (a status update
 * reflected in the UI, or the first console log line).
 */
export const WS_MESSAGE_TIMEOUT_MS = 30_000;

/** Poll interval when waiting for an async server-status transition via the API. */
export const STATUS_POLL_INTERVAL_MS = 2_000;

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
