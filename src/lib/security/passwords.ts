import crypto from 'node:crypto';

/**
 * Password hashing with scrypt (RFC 7914), the memory-hard KDF shipped in the
 * Node standard library. Parameters follow the OWASP recommendation of
 * N=2^17, r=8, p=1 with a 128 MiB working set.
 */

const N = 1 << 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

export const PASSWORD_ALGO = `scrypt$${N}$${R}$${P}`;

export function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

export async function verifyPassword(password: string, salt: string, expectedHex: string): Promise<boolean> {
  const actual = await hashPassword(password, salt);
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface PasswordPolicyResult {
  readonly ok: boolean;
  readonly problems: string[];
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters long');
  if (password.length > 512) problems.push('must be at most 512 characters long');
  if (!/[a-z]/.test(password)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('must contain an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('must contain a digit');
  return { ok: problems.length === 0, problems };
}
