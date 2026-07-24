/**
 * Minimal typed REST client for setup/assert helpers — NOT for driving features
 * (specs exercise features through the UI). It logs in, and creates/reads/deletes
 * game servers plus polls their status, so a spec can get-or-create the shared
 * test server without clicking through the whole creation wizard every time.
 *
 * Auth model (see backend AuthorizationController):
 *   POST /api/auth/login?tokenMode=DIRECT  → { refreshToken }
 *   GET  /api/auth/token   (Cookie: refreshToken=…)  → identity token (bearer)
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
    const loginRes = await fetch(`${this.apiBase}/auth/login?tokenMode=DIRECT`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    });
    if (!loginRes.ok) {
      throw new Error(`Login failed: ${loginRes.status} ${await safeText(loginRes)}`);
    }
    const { refreshToken } = (await loginRes.json()) as { refreshToken?: string };
    if (!refreshToken) throw new Error('Login response did not contain a refreshToken.');
    this.refreshToken = refreshToken;
    await this.refreshBearer();
  }

  /** Exchange the refresh token for a fresh identity (bearer) token. */
  async refreshBearer(): Promise<string> {
    if (!this.refreshToken) throw new Error('Not logged in — call login() first.');
    const res = await fetch(`${this.apiBase}/auth/token`, {
      headers: { Cookie: `refreshToken=${this.refreshToken}` },
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await safeText(res)}`);
    this.bearer = (await res.text()).trim();
    if (!this.bearer) throw new Error('Token endpoint returned an empty identity token.');
    return this.bearer;
  }

  async logout(): Promise<void> {
    await fetch(`${this.apiBase}/auth/logout`, { method: 'POST', headers: this.authHeaders() });
    this.bearer = null;
    this.refreshToken = null;
  }

  async listServers(): Promise<GameServer[]> {
    const res = await this.get('/game-server');
    return (await res.json()) as GameServer[];
  }

  async getServer(uuid: string): Promise<GameServer> {
    const res = await this.get(`/game-server/${uuid}`);
    return (await res.json()) as GameServer;
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
    const res = await this.request('POST', '/game-server', body);
    return (await res.json()) as GameServer;
  }

  async deleteServer(uuid: string): Promise<void> {
    await this.request('DELETE', `/game-server/${uuid}`);
  }

  async startServer(uuid: string): Promise<void> {
    await this.request('POST', `/game-server/${uuid}/start`);
  }

  async stopServer(uuid: string): Promise<void> {
    await this.request('POST', `/game-server/${uuid}/stop`);
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

  private async get(pathname: string): Promise<Response> {
    return this.request('GET', pathname);
  }

  private async request(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<Response> {
    const res = await fetch(`${this.apiBase}${pathname}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new Error(`${method} ${pathname} → ${res.status} ${await safeText(res)}`);
    }
    return res;
  }
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

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}
