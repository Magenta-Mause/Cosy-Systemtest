/**
 * Reads the admin credentials the way a real user would: from the installer's
 * printed summary block (teed to a log file), and cross-checks them against the
 * generated `.env`. Two distinct failure modes are kept separate on purpose:
 *
 *   - the summary printed the wrong password  → "summary/stdout is lying"
 *   - the summary and .env disagree           → distinct, louder error
 *   - login itself fails with matching creds   → surfaced later by the auth spec
 *
 * Env:
 *   INSTALL_LOG   path to the teed installer stdout (required to parse creds)
 *   INSTALL_DIR   install directory, default `/opt/cosy` — `.env` is read from
 *                 `${INSTALL_DIR}/config/.env`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AdminCredentials {
  username: string;
  password: string;
  /** Access URL printed by the installer, e.g. http://localhost:8080. */
  accessUrl?: string;
}

const DEFAULT_INSTALL_DIR = '/opt/cosy';

/** ANSI colour codes are present in the tee'd output — strip them before parsing. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * The summary block printed by install_cosy.sh (docker path) looks like:
 *
 *   ── Login Credentials ──────────────────────────────────
 *   Username:           admin
 *   Password:           <30 alphanumeric chars>
 *
 *   ── Access URL ────────────────────────────────────────
 *   COSY:               http://localhost:8080
 *
 * We anchor on those labels. Values never contain spaces (username is
 * alphanumeric, password is `[A-Za-z0-9]{30}`), so a non-greedy tail is safe.
 */
const USERNAME_RE = /^\s*Username:\s+(\S.*?)\s*$/m;
const PASSWORD_RE = /^\s*Password:\s+(\S.*?)\s*$/m;
const ACCESS_URL_RE = /^\s*COSY:\s+(\S+)\s*$/m;
const SUMMARY_MARKER = 'installation completed successfully';

/**
 * Parse admin credentials from the installer stdout log.
 * Throws a descriptive error (quoting nearby lines) if the format changed.
 */
export function parseCredentialsFromLog(logPath: string): AdminCredentials {
  if (!fs.existsSync(logPath)) {
    throw new Error(
      `Installer log not found at "${logPath}". Set INSTALL_LOG to the file the ` +
        `workflow tees "install_cosy.sh ... | tee install.log" into.`,
    );
  }

  const raw = stripAnsi(fs.readFileSync(logPath, 'utf-8'));

  if (!raw.includes(SUMMARY_MARKER)) {
    throw new Error(
      `Installer log "${logPath}" does not contain the success summary ` +
        `("${SUMMARY_MARKER}"). The install likely failed before printing ` +
        `credentials. Last lines were:\n${tail(raw)}`,
    );
  }

  const username = USERNAME_RE.exec(raw)?.[1];
  const password = PASSWORD_RE.exec(raw)?.[1];
  const accessUrl = ACCESS_URL_RE.exec(raw)?.[1];

  if (!username || !password) {
    throw new Error(
      `Could not parse admin credentials from the installer summary in ` +
        `"${logPath}". The summary format in install_cosy.sh may have changed ` +
        `(expected "Username:" / "Password:" labels). Relevant lines were:\n` +
        excerptAroundCredentials(raw),
    );
  }

  return { username, password, accessUrl };
}

/**
 * Read `ADMIN_USERNAME` / `ADMIN_PASSWORD` from the installer-written `.env`.
 *
 * Prefers `INSTALL_ENV_FILE` when set — the installed `.env` is root-owned and
 * chmod 600, so CI copies it to a runner-readable location rather than mutating
 * the installed state under test. Falls back to `${INSTALL_DIR}/config/.env`
 * (INSTALL_DIR default `/opt/cosy`) for local runs where the user can read it.
 */
export function readCredentialsFromEnvFile(installDir = envInstallDir()): AdminCredentials {
  const envPath = process.env.INSTALL_ENV_FILE ?? path.join(installDir, 'config', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `.env not found at "${envPath}". Set INSTALL_ENV_FILE to a runner-readable ` +
        `copy, or INSTALL_DIR to the Cosy install directory (default ` +
        `"${DEFAULT_INSTALL_DIR}"), where config/.env is readable.`,
    );
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const username = envValue(content, 'ADMIN_USERNAME');
  const password = envValue(content, 'ADMIN_PASSWORD');

  if (!username || !password) {
    throw new Error(
      `ADMIN_USERNAME / ADMIN_PASSWORD missing from "${envPath}". The .env layout ` +
        `written by install_cosy.sh may have changed.`,
    );
  }

  return { username, password };
}

/**
 * Parse creds from stdout AND cross-check them against `.env`. A mismatch is its
 * own error, so "login broken" and "summary prints the wrong password" stay
 * distinguishable (see plan 3.1).
 */
export function resolveAdminCredentials(): AdminCredentials {
  const logPath = requireEnv('INSTALL_LOG');
  const fromLog = parseCredentialsFromLog(logPath);
  const fromEnv = readCredentialsFromEnvFile();

  if (fromLog.username !== fromEnv.username || fromLog.password !== fromEnv.password) {
    throw new Error(
      `Installer stdout credentials do NOT match ${envInstallDir()}/config/.env.\n` +
        `  stdout : username="${fromLog.username}" password="${mask(fromLog.password)}"\n` +
        `  .env   : username="${fromEnv.username}" password="${mask(fromEnv.password)}"\n` +
        `This means the printed summary is lying about the real credentials.`,
    );
  }

  return fromLog;
}

// ── internals ───────────────────────────────────────────────────────────────

function envInstallDir(): string {
  return process.env.INSTALL_DIR ?? DEFAULT_INSTALL_DIR;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

function envValue(content: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
  return m?.[1]?.trim();
}

function mask(secret: string): string {
  if (secret.length <= 4) return '****';
  return `${secret.slice(0, 2)}…${secret.slice(-2)} (${secret.length} chars)`;
}

function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

function excerptAroundCredentials(text: string): string {
  const all = text.split('\n');
  const idx = all.findIndex((l) => /Login Credentials|Username:|Password:/.test(l));
  if (idx === -1) return tail(text);
  return all.slice(Math.max(0, idx - 2), idx + 6).join('\n');
}
