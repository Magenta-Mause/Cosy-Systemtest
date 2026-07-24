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
import {
  SERVER_COLD_START_TIMEOUT_MS,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_TIMEOUT_MS,
  TOSIOS_IMAGE,
} from './constants';
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
  /** Present on GET /game-server/{uuid}; used for access-group cleanup. */
  access_groups?: AccessGroup[];
}

export interface CreateGameServerInput {
  server_name: string;
  docker_image_name: string;
  docker_image_tag?: string;
  /** Unit-suffixed memory string, e.g. "512MiB". */
  memory_limit?: string;
  /** Container env vars (e.g. EULA/RCON for the itzg Minecraft server). */
  environment_variables?: Record<string, string>;
}

// ── Phase 2 wire types (snake_case, verified against backend DTOs) ────────────

/** UserEntity.Role — the only three roles the backend defines (no USER/MODERATOR). */
export type UserRole = 'OWNER' | 'ADMIN' | 'QUOTA_USER';

export interface DockerHardwareLimits {
  docker_max_cpu_cores?: number;
  docker_memory_limit?: string;
}

export interface UserEntity {
  uuid: string;
  username: string;
  role?: UserRole;
  docker_hardware_limits?: DockerHardwareLimits;
  can_create_game_servers?: boolean;
}

export interface UserInvite {
  uuid: string;
  username: string;
  /** The redeem token — POST /user-invites/use/{secret_key}. */
  secret_key: string;
  role?: UserRole | null;
  docker_hardware_limits?: DockerHardwareLimits;
  can_create_game_servers?: boolean;
}

/** GameServerLogMessageEntity — history rows are objects, not strings. */
export interface GameServerLogMessage {
  game_server_uuid: string;
  message: string;
  level: 'INFO' | 'ERROR' | 'INPUT' | 'COSY_INFO' | 'COSY_DEBUG' | 'COSY_ERROR';
  timestamp: string;
}

export interface MetricValues {
  cpu_percent?: number;
  memory_percent?: number;
  memory_usage?: number;
  memory_limit?: number;
  network_input?: number;
  network_output?: number;
}

export interface MetricPoint {
  game_server_uuid: string;
  time: string;
  metric_values: MetricValues;
}

export interface Template {
  uuid: string;
  name: string;
  game_id: string;
  docker_image_name?: string;
  docker_image_tag?: string;
}

export interface Game {
  game_uuid: string;
  name: string;
  external_game_id?: number;
  slug?: string;
  /** Grid/artwork image. */
  hero_url?: string;
  logo_url?: string;
}

export type WebhookType = 'DISCORD' | 'SLACK' | 'N8N';
export type GameServerEventType = 'SERVER_STARTED' | 'SERVER_STOPPED' | 'SERVER_FAILED';

export interface Webhook {
  uuid: string;
  webhook_type: WebhookType;
  webhook_url: string;
  enabled: boolean;
  subscribed_events: GameServerEventType[];
}

export type GameServerDesign = 'HOUSE' | 'CASTLE';

/** Subset of GameServerAccessPermission used by the access-management spec. */
export type GameServerAccessPermission =
  | 'ADMIN'
  | 'SEE_SERVER'
  | 'START_STOP_SERVER'
  | 'READ_SERVER_LOGS'
  | 'READ_SERVER_METRICS'
  | 'SEND_COMMANDS'
  | 'CHANGE_SERVER_FILES'
  | 'CHANGE_SERVER_CONFIGS';

export interface AccessGroup {
  uuid: string;
  group_name: string;
  permissions: GameServerAccessPermission[];
  users: UserEntity[];
  game_server_uuid: string;
}

export interface RconConfiguration {
  enabled: boolean;
  port: number;
  password: string;
}

/** A fully-usable second account created over the API for multi-user specs. */
export interface ProvisionedUser {
  uuid: string;
  username: string;
  /** The password the account was provisioned with (usable for UI login). */
  password: string;
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
      // GameServerCreationDto.environmentVariables is a
      // List<EnvironmentVariableConfiguration> ({ key, value }), NOT a map. Reshape
      // the convenient Record input into that list shape (key/value are single-word
      // fields → no snake conversion). Sending a bare map yields a 400
      // ("this endpoint expects a different request body").
      ...(input.environment_variables
        ? {
            environment_variables: Object.entries(input.environment_variables).map(
              ([key, value]) => ({ key, value }),
            ),
          }
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
   * Wait until a server is in a state from which `start()` is legal — the backend
   * rejects `POST /start` with 409 unless the status `isStopped()` (STOPPED or
   * FAILED). A server that was just started (image pull) transiently reports
   * AWAITING_UPDATE / PULLING_IMAGE, and one being stopped reports STOPPING; none
   * are terminal, so we keep polling. RUNNING is also an acceptable resting state
   * — the shared tosios server is looked up BY NAME and therefore shared across
   * parallel workers, so another worker may already have started it; we return it
   * so the caller can skip its own start. Only a timeout is an error.
   */
  async waitUntilStartable(
    uuid: string,
    timeoutMs = SERVER_COLD_START_TIMEOUT_MS,
  ): Promise<GameServerStatus | undefined> {
    const deadline = Date.now() + timeoutMs;
    let last: GameServerStatus | undefined;
    while (Date.now() < deadline) {
      last = await this.getStatus(uuid);
      if (last === 'STOPPED' || last === 'FAILED' || last === 'RUNNING') return last;
      // AWAITING_UPDATE / PULLING_IMAGE / STOPPING → still settling, keep waiting.
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Server ${uuid} did not become startable within ${timeoutMs}ms (last status: ${last}).`,
    );
  }

  /**
   * Idempotently bring a server to RUNNING. Replaces the ad-hoc
   * `if (status !== 'RUNNING') { startServer; waitForStatus('RUNNING') }` blocks
   * that 409'd or timed out under image-pull contention (two PaperMC pulls now
   * boot concurrently with the tosios specs on a 4-vCPU runner, stalling tosios
   * servers in AWAITING_UPDATE). It waits until the server is startable, starts it
   * unless it is already up, and tolerates a 409 from a worker that raced us to
   * the start of the shared-by-name server (we then simply wait for the RUNNING it
   * will reach). The RUNNING budget is generous by default; heavy servers pass a
   * larger one (e.g. Minecraft world-gen).
   */
  async ensureRunning(uuid: string, runningTimeoutMs = SERVER_COLD_START_TIMEOUT_MS): Promise<void> {
    const settled = await this.waitUntilStartable(uuid);
    if (settled === 'RUNNING') return;
    try {
      await this.startServer(uuid);
    } catch (err) {
      // A parallel worker may have started the shared-by-name server between our
      // status read and this call (409 "not in a stopped state" / "already
      // starting"). That is fine — fall through and wait for the RUNNING it reaches.
      if (!/\b409\b/.test(String(err))) throw err;
    }
    await this.waitForStatus(uuid, 'RUNNING', runningTimeoutMs);
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

  /** Return a named server, creating it from an arbitrary image if absent. */
  async getOrCreateServer(input: CreateGameServerInput): Promise<GameServer> {
    const existing = (await this.listServers()).find((s) => s.server_name === input.server_name);
    if (existing) return existing;
    return this.createServer(input);
  }

  // ── invites & users (setup/teardown for invites/user-management/access specs) ─

  async createInvite(input: {
    username: string;
    role?: UserRole;
    can_create_game_servers?: boolean;
  }): Promise<UserInvite> {
    return this.send<UserInvite>('POST', '/user-invites', input, 'Create invite');
  }

  /** Redeem an invite (the token is a PATH variable, not a query/body field). */
  async redeemInvite(secretKey: string, username: string, password: string): Promise<UserEntity> {
    return this.send<UserEntity>(
      'POST',
      `/user-invites/use/${encodeURIComponent(secretKey)}`,
      { username, password },
      'Redeem invite',
    );
  }

  async deleteInvite(uuid: string): Promise<void> {
    await this.send<void>('DELETE', `/user-invites/${uuid}`);
  }

  async listUsers(): Promise<UserEntity[]> {
    return this.send<UserEntity[]>('GET', '/user-entity');
  }

  async getUser(uuid: string): Promise<UserEntity> {
    return this.send<UserEntity>('GET', `/user-entity/${uuid}`);
  }

  async deleteUser(uuid: string): Promise<void> {
    await this.send<void>('DELETE', `/user-entity/${uuid}`);
  }

  async changeRole(uuid: string, role: UserRole): Promise<UserEntity> {
    return this.send<UserEntity>('PATCH', `/user-entity/${uuid}/change-role`, { role }, 'Change role');
  }

  async updateDockerLimits(uuid: string, limits: DockerHardwareLimits): Promise<UserEntity> {
    return this.send<UserEntity>(
      'PATCH',
      `/user-entity/${uuid}/docker-limits`,
      { docker_hardware_limits: limits },
      'Update docker limits',
    );
  }

  /**
   * Provision a fully-usable second account over the API in one call — invite +
   * redeem with the FINAL password — for specs that need a real non-admin user as a
   * precondition (not as the feature under test).
   *
   * Redeeming an invite sets the account password directly (UserInviteService
   * encodes the supplied password), and no forced first-login change is enforced
   * (`defaultPasswordReset` is a dormant no-op — see docs/KNOWN-ISSUES.md), so the
   * user can log in with `finalPassword` immediately. We deliberately do NOT call
   * `/user-entity/{uuid}/change-password`: that is the SELF endpoint and returns
   * 403 FORBIDDEN when invoked with the admin bearer for another user's uuid.
   */
  async provisionUser(username: string, finalPassword: string): Promise<ProvisionedUser> {
    const invite = await this.createInvite({ username, role: 'QUOTA_USER' });
    const user = await this.redeemInvite(invite.secret_key, username, finalPassword);
    return { uuid: user.uuid, username, password: finalPassword };
  }

  // ── logs & metrics (fallback asserts / readiness polling) ───────────────────

  async getLogs(uuid: string, limit = 500, sinceHours = 5): Promise<GameServerLogMessage[]> {
    // Query-param names are NOT snake_cased (only JSON bodies are) — sinceHours.
    return this.send<GameServerLogMessage[]>(
      'GET',
      `/game-server/${uuid}/logs?limit=${limit}&sinceHours=${sinceHours}`,
    );
  }

  /**
   * Poll the history endpoint until a log line matches `pattern` (or time out).
   * Used to detect container readiness (e.g. itzg "Done") and as a fallback assert
   * that historical Loki-backed lines exist. Loki ingestion lags, hence the poll.
   */
  async waitForLogMatch(
    uuid: string,
    pattern: RegExp,
    timeoutMs: number,
  ): Promise<GameServerLogMessage> {
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      const lines = await this.getLogs(uuid, 1000, 5);
      count = lines.length;
      const hit = lines.find((l) => pattern.test(l.message));
      if (hit) return hit;
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    throw new Error(
      `No log line matching ${pattern} for server ${uuid} within ${timeoutMs}ms ` +
        `(saw ${count} lines).`,
    );
  }

  async getMetrics(uuid: string, pointCount = 100): Promise<MetricPoint[]> {
    return this.send<MetricPoint[]>('GET', `/game-server/${uuid}/metrics?pointCount=${pointCount}`);
  }

  async getPublicMetrics(uuid: string, pointCount = 100): Promise<MetricPoint[]> {
    return this.send<MetricPoint[]>(
      'GET',
      `/game-server/${uuid}/metrics/public?pointCount=${pointCount}`,
    );
  }

  // ── templates & games (verify hosted catalog reachability) ──────────────────

  async listTemplates(): Promise<Template[]> {
    return this.send<Template[]>('GET', '/templates');
  }

  async searchGames(query: string): Promise<Game[]> {
    return this.send<Game[]>('GET', `/games?query=${encodeURIComponent(query)}`);
  }

  // ── rcon & console command ──────────────────────────────────────────────────

  async setRconConfiguration(uuid: string, config: RconConfiguration): Promise<GameServer> {
    // RCONConfiguration fields are single-word — no snake conversion.
    return this.send<GameServer>('PATCH', `/game-server/${uuid}/rcon-configuration`, config);
  }

  /** Fire-and-forget console command (204; any response surfaces in the log stream). */
  async sendCommand(uuid: string, command: string): Promise<void> {
    await this.send<void>('POST', `/game-server/${uuid}/send-command`, { command });
  }

  // ── webhooks ────────────────────────────────────────────────────────────────

  async listWebhooks(uuid: string): Promise<Webhook[]> {
    return this.send<Webhook[]>('GET', `/game-server/${uuid}/webhooks`);
  }

  async createWebhook(
    uuid: string,
    input: {
      webhook_type: WebhookType;
      webhook_url: string;
      subscribed_events: GameServerEventType[];
      enabled?: boolean;
    },
  ): Promise<Webhook> {
    return this.send<Webhook>('POST', `/game-server/${uuid}/webhooks`, {
      enabled: true,
      ...input,
    });
  }

  async deleteWebhook(uuid: string, webhookUuid: string): Promise<void> {
    await this.send<void>('DELETE', `/game-server/${uuid}/webhooks/${webhookUuid}`);
  }

  // ── access groups ────────────────────────────────────────────────────────────

  async createAccessGroup(uuid: string, name: string): Promise<AccessGroup> {
    // AccessGroupCreationDto.name is single-word (no @JsonNaming on this DTO).
    return this.send<AccessGroup>('POST', `/game-server/${uuid}/access-groups`, { name });
  }

  /** Add members + grant permissions (replaces the group's membership/permissions). */
  async updateAccessGroup(
    uuid: string,
    groupUuid: string,
    input: {
      access_group_name: string;
      user_uuids: string[];
      permissions: GameServerAccessPermission[];
    },
  ): Promise<AccessGroup[]> {
    return this.send<AccessGroup[]>(
      'PATCH',
      `/game-server/${uuid}/access-groups/${groupUuid}`,
      input,
    );
  }

  async deleteAccessGroup(uuid: string, groupUuid: string): Promise<void> {
    await this.send<void>('DELETE', `/game-server/${uuid}/access-groups/${groupUuid}`);
  }

  // ── design & public dashboard ────────────────────────────────────────────────

  async setDesign(uuid: string, design: GameServerDesign): Promise<GameServer> {
    return this.send<GameServer>('PATCH', `/game-server/${uuid}/design`, { design });
  }

  async setPublicDashboard(
    uuid: string,
    enabled: boolean,
    layouts: unknown[] = [],
  ): Promise<void> {
    await this.send<void>('PATCH', `/game-server/${uuid}/layout/public-dashboard`, {
      enabled,
      layouts,
    });
  }

  /**
   * Set the server's metric dashboard layout (setup) so the metrics page renders
   * the expected CPU/Memory cards deterministically. Body is a List<MetricLayout>
   * ({ size, metric_type }).
   */
  async setMetricLayout(uuid: string, layouts: unknown[]): Promise<void> {
    await this.send<void>('PATCH', `/game-server/${uuid}/layout/metric`, layouts);
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
