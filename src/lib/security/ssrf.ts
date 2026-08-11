import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '@/lib/config/env';

/**
 * SSRF protection for every outbound URL the research engine is asked to visit.
 *
 * The check is performed on the *resolved addresses*, not on the hostname, so
 * DNS entries that point at internal space (a very common SSRF vector) are
 * rejected. Each redirect hop is re-validated by the fetcher.
 */

export class BlockedUrlError extends Error {
  readonly status = 400;
  constructor(readonly url: string, readonly reason: string) {
    super(`Blocked URL ${url}: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  return ((parts[0] ?? 0) << 24) >>> 0 | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
}

const V4_BLOCKS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const value = ipv4ToInt(address);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (value & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (version === 6) {
    const norm = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (norm === '::' || norm === '::1') return true;
    if (norm.startsWith('fe80') || norm.startsWith('fc') || norm.startsWith('fd')) return true;
    if (norm.startsWith('ff')) return true;
    // IPv4-mapped addresses (::ffff:10.0.0.1) inherit the IPv4 rules.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(norm);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export interface UrlGuardResult {
  readonly url: URL;
  readonly addresses: string[];
}

export async function assertSafeUrl(input: string | URL): Promise<UrlGuardResult> {
  const cfg = config();
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    throw new BlockedUrlError(String(input), 'not a valid absolute URL');
  }

  if (!cfg.RESEARCH_ALLOWED_SCHEMES.includes(url.protocol)) {
    throw new BlockedUrlError(url.href, `scheme "${url.protocol}" is not allowed`);
  }
  if (url.username || url.password) {
    throw new BlockedUrlError(url.href, 'embedded credentials are not allowed');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (cfg.RESEARCH_HOST_DENYLIST.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
    throw new BlockedUrlError(url.href, 'host is on the operator denylist');
  }
  const allowPrivate = cfg.RESEARCH_ALLOW_PRIVATE_HOSTS;
  if (!allowPrivate) {
    if (BLOCKED_HOSTNAMES.has(hostname)) throw new BlockedUrlError(url.href, 'hostname is blocked');
    if (hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
      throw new BlockedUrlError(url.href, 'internal TLD is blocked');
    }
  }

  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch (error) {
      throw new BlockedUrlError(url.href, `DNS resolution failed: ${(error as Error).message}`);
    }
  }
  if (addresses.length === 0) throw new BlockedUrlError(url.href, 'hostname resolved to no addresses');
  if (!allowPrivate) {
    const blocked = addresses.find((a) => isPrivateAddress(a));
    if (blocked) throw new BlockedUrlError(url.href, `resolves to non-public address ${blocked}`);
  }

  return { url, addresses };
}
