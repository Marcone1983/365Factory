import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { db, newId, nowIso } from '@/lib/db/client';
import { config } from '@/lib/config/env';
import { hashPassword, generateSalt, verifyPassword, PASSWORD_ALGO, checkPasswordPolicy } from './passwords';
import { type Role, type Permission, requirePermission, permissionsFor } from './rbac';
import { audit } from './audit';
import { consumeLogin, RateLimitError } from './ratelimit';

export const SESSION_COOKIE = 'adaf_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly password_salt: string;
  readonly password_algo: string;
  readonly role: Role;
  readonly display_name: string;
  readonly status: 'active' | 'disabled';
  readonly failed_logins: number;
  readonly locked_until: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_login_at: string | null;
}

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly displayName: string;
  readonly permissions: readonly Permission[];
}

export interface SessionContext {
  readonly user: AuthUser;
  readonly sessionId: string;
  readonly csrfToken: string;
}

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function tokenHash(token: string): string {
  return crypto.createHmac('sha256', config().sessionSecret).update(token).digest('hex');
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    displayName: row.display_name || row.email,
    permissions: permissionsFor(row.role),
  };
}

// ------------------------------------------------------------------- users --

export async function createUser(params: {
  email: string;
  password: string;
  role: Role;
  displayName?: string;
}): Promise<AuthUser> {
  const policy = checkPasswordPolicy(params.password);
  if (!policy.ok) throw new Error(`Password policy violation: ${policy.problems.join(', ')}`);
  const email = params.email.trim().toLowerCase();
  const salt = generateSalt();
  const hash = await hashPassword(params.password, salt);
  const id = newId('usr');
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, password_algo, role, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, email, hash, salt, PASSWORD_ALGO, params.role, params.displayName ?? '', now, now);
  audit({ actorType: 'system', action: 'user.create', targetType: 'user', targetId: id, metadata: { email, role: params.role } });
  return { id, email, role: params.role, displayName: params.displayName ?? email, permissions: permissionsFor(params.role) };
}

export function findUserByEmail(email: string): UserRow | undefined {
  return db()
    .prepare<[string], UserRow>('SELECT * FROM users WHERE email = ?')
    .get(email.trim().toLowerCase());
}

export function countUsers(): number {
  const row = db().prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get();
  return row?.n ?? 0;
}

export async function changePassword(userId: string, newPassword: string): Promise<void> {
  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) throw new Error(`Password policy violation: ${policy.problems.join(', ')}`);
  const salt = generateSalt();
  const hash = await hashPassword(newPassword, salt);
  db()
    .prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_algo = ?, updated_at = ? WHERE id = ?')
    .run(hash, salt, PASSWORD_ALGO, nowIso(), userId);
  db().prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(nowIso(), userId);
  audit({ actorType: 'user', actorId: userId, action: 'user.password_change', targetType: 'user', targetId: userId });
}

// ---------------------------------------------------------------- sessions --

const LOCK_THRESHOLD = 8;
const LOCK_MINUTES = 15;

export interface LoginResult {
  readonly user: AuthUser;
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export async function login(params: {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<LoginResult> {
  const email = params.email.trim().toLowerCase();
  const limit = consumeLogin(params.ip ? `${email}|${params.ip}` : email);
  if (!limit.allowed) {
    audit({ actorType: 'anonymous', action: 'auth.login', outcome: 'denied', metadata: { email, reason: 'rate_limited' }, ip: params.ip });
    throw new RateLimitError(limit);
  }

  const row = findUserByEmail(email);
  // Always run a KDF pass so that response time does not disclose account existence.
  const salt = row?.password_salt ?? 'nonexistent-account-salt';
  const expected = row?.password_hash ?? crypto.randomBytes(64).toString('hex');
  const passwordOk = await verifyPassword(params.password, salt, expected);

  if (!row || row.status !== 'active' || !passwordOk) {
    if (row) {
      const failed = row.failed_logins + 1;
      const lockedUntil =
        failed >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : row.locked_until;
      db().prepare('UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(failed, lockedUntil, nowIso(), row.id);
    }
    audit({ actorType: 'anonymous', action: 'auth.login', outcome: 'failure', metadata: { email }, ip: params.ip });
    throw new AuthenticationError('Invalid email or password');
  }

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    audit({ actorType: 'user', actorId: row.id, action: 'auth.login', outcome: 'denied', metadata: { reason: 'locked' }, ip: params.ip });
    throw new AuthenticationError('Account temporarily locked after repeated failed attempts');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const sessionId = newId('ses');
  const expiresAt = new Date(Date.now() + config().SESSION_TTL_HOURS * 3600_000);

  db()
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip, user_agent, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, row.id, tokenHash(token), csrfToken, params.ip ?? null, params.userAgent ?? null, nowIso(), expiresAt.toISOString());

  db().prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
    .run(nowIso(), row.id);

  audit({ actorType: 'user', actorId: row.id, action: 'auth.login', outcome: 'success', ip: params.ip });
  return { user: toAuthUser(row), token, csrfToken, expiresAt };
}

export function revokeSession(sessionId: string): void {
  db().prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(nowIso(), sessionId);
}

export function purgeExpiredSessions(): number {
  const info = db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return info.changes;
}

interface SessionJoinRow extends UserRow {
  readonly session_id: string;
  readonly csrf_token: string;
}

export function resolveSessionToken(token: string): SessionContext | null {
  const row = db()
    .prepare<[string, string], SessionJoinRow>(
      `SELECT u.*, s.id AS session_id, s.csrf_token AS csrf_token
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(tokenHash(token), nowIso());
  if (!row || row.status !== 'active') return null;
  return { user: toAuthUser(row), sessionId: row.session_id, csrfToken: row.csrf_token };
}

/** Reads the session from the incoming request cookies. Returns null when absent. */
export async function getSession(): Promise<SessionContext | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveSessionToken(token);
}

export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw new AuthenticationError();
  return session;
}

export async function requireUser(permission: Permission): Promise<SessionContext> {
  const session = await requireSession();
  requirePermission(session.user.role, permission);
  return session;
}

export function sessionCookieOptions(expiresAt: Date): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  expires: Date;
} {
  return {
    httpOnly: true,
    secure: config().APP_URL.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

/**
 * Double-submit CSRF validation. Mutating API routes must call this; the token
 * is issued at login and mirrored into a readable cookie for the client.
 */
export function assertCsrf(session: SessionContext, request: Request): void {
  const provided = request.headers.get(CSRF_HEADER);
  if (!provided) throw new AuthenticationError('Missing CSRF token');
  const a = Buffer.from(provided);
  const b = Buffer.from(session.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AuthenticationError('Invalid CSRF token');
  }
  const origin = request.headers.get('origin');
  if (origin) {
    const allowed = new URL(config().APP_URL).origin;
    if (new URL(origin).origin !== allowed) throw new AuthenticationError('Cross-origin request rejected');
  }
}
