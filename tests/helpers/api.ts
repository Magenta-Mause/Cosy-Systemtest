/**
 * Minimal typed REST client for setup/assert helpers — NOT for driving features
 * (specs exercise features through the UI). It logs in, and creates/reads/deletes
 * game servers plus polls their status, so a spec can get-or-create the shared
 * test server without clicking through the whole creation wizard every time.
 *
 * WIRE FORMAT IS snake_case — both directions. The backend's Jackson ObjectMapper
 * uses SNAKE_CASE globally (application.yaml `spring.jackson.property-naming-strategy:
 * SNAKE_CASE` + UtilConfig), so every multi-word field is snake_case on the wire:
 * responses come back as `refresh_token` / `server_name` / `docker_image_name`, and
 * request bodies MUST be sent the same way. Do NOT "fix" these to camelCase.
 * (Single-word fields — username, password, uuid, status — are unaffected.)
 *
 * Auth model (see backend AuthorizationController):
 *   POST /api/auth/login?tokenMode=DIRECT  → data: { refresh_token }
 *   GET  /api/auth/token   (Cookie: refreshToken=…)  → data: identity token (bearer)
 * The identity token is a short-lived JWT sent as `Authorization: Bearer …`.
 */
import { API_CONTEXT_PATH, resolveBaseURL } from './constants';
import { STATUS_POLL_INTERVAL_MS, STATUS_POLL_TIMEOUT_MS, TOSIOS_IMAGE } from './constants';
import type { AdminCredentials } from './install';

export type GameServerStatus =
  | 'RUNNING'
  | 'STOPPED'
  | 'FAILED'
  | 'PULLING_IMAGE'
  | 'AWAITING_UPDATE'
  | 'STOPPING';

export interface GameServer {
  uuid: string;
  server_name: string;
  status?: GameServerStatus;
  docker_image_name?: string;
  docker_image_tag?: string;
}

export interface CreateGameServerInput {
  server_name: string;
  docker_image_name: string;
  docker_image_tag?: string;
  /** Unit-suffixed memory string, e.g. "512MiB". */
  memory_limit?: string;
}

export class ApiClient {
  private readonly apiBase: string;
  private refreshToken: string | null = null;
  private bearer: string | null = null;

  constructor(baseURL: string = resolveBaseURL()) {
    this.apiBase = `${baseURL.replace(/\/$/, '')}${API_CONTEXT_PATH}`;
  }

  /** Log in and obtain a bearer identity token for subsequent calls. */
  async login(creds: AdminCredentials): Promise<void> {
    // Response field is snake_case: data.refresh_token (see wire-format note above).
    const dto = await this.send<{ refresh_token?: string }>(
      'POST',
      '/auth/login?tokenMode=DIRECT',
      { username: creds.username, password: creds.password },
      'Login',
    );
    if (!dto?.refresh_token) throw new Error('Login response did not contain a refresh_token.');
    this.refreshToken = dto.refresh_token;
    await this.refreshBearer();
  }

  /** Exchange the refresh token for a fresh identity (bearer) token. */
  async refreshBearer(): Promise<string> {
    if (!this.refreshToken) throw new Error('Not logged in — call login() first.');
    // /auth/token returns a String body, which the backend still wraps in the
    // global envelope (data = the token string).
    const res = await fetch(`${this.apiBase}/auth/token`, {
      headers: { Cookie: `refreshToken=${this.refreshToken}` },
    });
    const token = await unwrap<string>(res, 'Token exchange');
    this.bearer = token?.trim() ?? null;
    if (!this.bearer) throw new Error('Token endpoint returned an empty identity token.');
    return this.bearer;
  }

  async logout(): Promise<void> {
    await this.send<void>('POST', '/auth/logout', undefined, 'Logout');
    this.bearer = null;
    this.refreshToken = null;
  }

  async listServers(): Promise<GameServer[]> {
    return this.send<GameServer[]>('GET', '/game-server');
  }

  async getServer(uuid: string): Promise<GameServer> {
    return this.send<GameServer>('GET', `/game-server/${uuid}`);
  }

  async createServer(input: CreateGameServerInput): Promise<GameServer> {
    const body = {
      server_name: input.server_name,
      docker_image_name: input.docker_image_name,
      docker_image_tag: input.docker_image_tag ?? 'latest',
      ...(input.memory_limit
        ? { docker_hardware_limits: { docker_memory_limit: input.memory_limit } }
        : {}),
    };
    return this.send<GameServer>('POST', '/game-server', body);
  }

  async deleteServer(uuid: string): Promise<void> {
    await this.send<void>('DELETE', `/game-server/${uuid}`);
  }

  async startServer(uuid: string): Promise<void> {
    await this.send<void>('POST', `/game-server/${uuid}/start`);
  }

  async stopServer(uuid: string): Promise<void> {
    await this.send<void>('POST', `/game-server/${uuid}/stop`);
  }

  async getStatus(uuid: string): Promise<GameServerStatus | undefined> {
    return (await this.getServer(uuid)).status;
  }

  /** Poll a server until it reaches `target` (or a terminal FAILED) or times out. */
  async waitForStatus(
    uuid: string,
    target: GameServerStatus,
    timeoutMs = STATUS_POLL_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: GameServerStatus | undefined;
    while (Date.now() < deadline) {
      last = await this.getStatus(uuid);
      if (last === target) return;
      if (last === 'FAILED' && target !== 'FAILED') {
        throw new Error(`Server ${uuid} reached FAILED while waiting for ${target}.`);
      }
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Server ${uuid} did not reach ${target} within ${timeoutMs}ms (last status: ${last}).`,
    );
  }

  /**
   * Return the reusable tosios test server, creating it if absent. Keeps the
   * lifecycle/console/files specs independent (each can provision its own) while
   * avoiding a fresh pull per spec.
   */
  async getOrCreateTosiosServer(name: string, memoryLimit: string): Promise<GameServer> {
    const existing = (await this.listServers()).find((s) => s.server_name === name);
    if (existing) return existing;
    return this.createServer({
      server_name: name,
      docker_image_name: TOSIOS_IMAGE,
      docker_image_tag: 'latest',
      memory_limit: memoryLimit,
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {};
  }

  /** Fetch + unwrap the global response envelope in one step. */
  private async send<T>(
    method: string,
    pathname: string,
    body?: unknown,
    context?: string,
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}${pathname}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return unwrap<T>(res, context ?? `${method} ${pathname}`);
  }
}

/**
 * The backend wraps EVERY JSON response in a global envelope
 * (`GlobalResponseWrapper`): `{ data, success, error, path, status_code, timestamp }`.
 * This unwraps `data`, asserting `success === true`, and surfaces `error` (and the
 * raw body) in the failure message. Void endpoints (start/stop/delete/logout) carry
 * no `data`, so callers of those ignore the (undefined) result.
 */
interface ApiEnvelope<T> {
  data?: T;
  success?: boolean;
  error?: string | null;
  status_code?: number;
  path?: string;
}

async function unwrap<T>(res: Response, context: string): Promise<T> {
  const raw = await res.text();
  let env: ApiEnvelope<T> | undefined;
  try {
    env = raw ? (JSON.parse(raw) as ApiEnvelope<T>) : undefined;
  } catch {
    // Non-JSON body — leave env undefined and let the checks below report it.
  }

  if (!res.ok) {
    const detail = env?.error ?? raw ?? '<no body>';
    throw new Error(`${context} → ${res.status} ${detail}`);
  }
  if (env && env.success === false) {
    throw new Error(`${context} → API reported failure: ${env.error ?? '<no error message>'}`);
  }
  return env?.data as T;
}

/** Convenience: build a client, log in, return it. */
export async function loginApiClient(creds: AdminCredentials): Promise<ApiClient> {
  const client = new ApiClient();
  await client.login(creds);
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
