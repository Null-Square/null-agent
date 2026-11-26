import { promises as dns } from 'node:dns';
import net from 'node:net';

/**
 * The outbound-request boundary for anything that fetches a user-supplied host.
 *
 * The anonymous scan preview accepts a domain from an unauthenticated visitor
 * and makes requests to it. That is textbook SSRF exposure: without this guard a
 * visitor can point us at `169.254.169.254` and read cloud instance credentials,
 * or at an internal service that trusts anything originating inside the VPC.
 *
 * Three rules, and all three matter:
 *
 *  1. The client is not a trust boundary. The website parses and normalises the
 *     domain before submitting it; we re-derive it here from scratch and assume
 *     the submitted value is hostile.
 *  2. Resolve, then pin. We return the resolved addresses so the caller connects
 *     to a checked IP. Validating a hostname and then handing that hostname to a
 *     fetch lets an attacker re-answer the second lookup with a private address
 *     (DNS rebinding); the check and the connection must agree on one address.
 *  3. Every redirect hop is a new host. Callers must re-run the guard per hop.
 *
 * Kept deliberately free of scan-preview specifics so the verified-tier runner
 * and any future outbound-fetch feature share exactly one implementation.
 */

export type HostRejectionReason =
  | 'invalid'
  | 'ip_literal'
  | 'non_public_suffix'
  | 'denylisted'
  | 'unresolvable'
  | 'private_address';

export type HostGuardResult =
  | { status: 'allowed'; hostname: string; addresses: string[] }
  | { status: 'rejected'; reason: HostRejectionReason; detail: string };

const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const TLD = /^(?:xn--[a-z0-9-]+|[\p{L}]{2,})$/u;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Suffixes that only resolve on a private network. */
const NON_PUBLIC_SUFFIXES = new Set([
  'local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp', 'invalid', 'test', 'example',
]);

/**
 * Refused outright regardless of who asks. Government and military estates are
 * excluded because an unauthenticated stranger must never be able to make this
 * platform touch them, however benign the request.
 */
const DENYLISTED_SUFFIXES = new Set(['gov', 'mil', 'int']);

/** CIDR blocks that must never be the destination of an outbound request. */
const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918 private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local — includes cloud metadata at 169.254.169.254
  ['172.16.0.0', 12],    // RFC1918 private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // RFC1918 private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, includes 255.255.255.255
] as const;

const BLOCKED_V6 = [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['100::', 64],         // discard-only
  ['2001:db8::', 32],    // documentation
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['ff00::', 8],         // multicast
] as const;

const v4ToBytes = (ip: string): Uint8Array | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
};

const v6ToBytes = (ip: string): Uint8Array | null => {
  // An IPv4-mapped or IPv4-embedded tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is
  // rewritten to hex first so one parser handles every form.
  let value = ip;
  const tail = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/u);
  if (tail) {
    const v4 = v4ToBytes(tail[1]);
    if (!v4) return null;
    const hex = `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
    value = `${value.slice(0, tail.index)}${hex}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const groups: number[] = [];
    for (const group of chunk.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  const tailGroups = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !tailGroups) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tailGroups];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
};

const withinCidr = (address: Uint8Array, network: Uint8Array, prefix: number): boolean => {
  const wholeBytes = prefix >> 3;
  for (let i = 0; i < wholeBytes; i += 1) {
    if (address[i] !== network[i]) return false;
  }
  const remainder = prefix & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return (address[wholeBytes] & mask) === (network[wholeBytes] & mask);
};

/**
 * True when the address is globally routable and safe to connect to.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is unwrapped and re-checked against the
 * v4 table — otherwise it is a trivial bypass of every v4 rule above.
 */
export const isPublicAddress = (ip: string): boolean => {
  if (net.isIPv4(ip)) {
    const bytes = v4ToBytes(ip);
    if (!bytes) return false;
    return !BLOCKED_V4.some(([network, prefix]) => {
      const networkBytes = v4ToBytes(network);
      return networkBytes ? withinCidr(bytes, networkBytes, prefix) : false;
    });
  }

  if (net.isIPv6(ip)) {
    const bytes = v6ToBytes(ip);
    if (!bytes) return false;

    // ::ffff:0:0/96 (IPv4-mapped) and 2002::/16 (6to4) both carry a v4 address.
    const isV4Mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isV4Mapped) {
      return isPublicAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
      return isPublicAddress(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    }

    return !BLOCKED_V6.some(([network, prefix]) => {
      const networkBytes = v6ToBytes(network);
      return networkBytes ? withinCidr(bytes, networkBytes, prefix) : false;
    });
  }

  return false;
};

/**
 * Re-derives a hostname from raw input. Mirrors the website's parser, but this
 * is the authoritative copy: the browser's result is a convenience, never a
 * guarantee.
 */
export const normalizeHostname = (raw: string): { hostname: string } | { reason: HostRejectionReason; detail: string } => {
  let value = (raw ?? '').trim().toLowerCase();
  if (!value) return { reason: 'invalid', detail: 'empty input' };

  const atIndex = value.lastIndexOf('@');
  if (atIndex >= 0) value = value.slice(atIndex + 1);

  value = value.replace(SCHEME, '');
  value = value.split(/[/?#\\]/u)[0];

  // IP literals must be caught BEFORE the port is stripped. The port pattern
  // would otherwise eat the final group of an address like `::1`, leaving a
  // mangled string that no longer looks like an IP and gets misclassified.
  const colonCount = (value.match(/:/gu) ?? []).length;
  if (value.startsWith('[') || colonCount >= 2 || net.isIP(value) !== 0) {
    return { reason: 'ip_literal', detail: 'bare IP addresses are not accepted' };
  }

  value = value.replace(/:\d+$/u, '');
  value = value.replace(/^\.+|\.+$/gu, '');
  value = value.replace(/^www\./u, '');

  if (!value) return { reason: 'invalid', detail: 'no host component' };
  if (net.isIP(value) !== 0) {
    return { reason: 'ip_literal', detail: 'bare IP addresses are not accepted' };
  }
  if (value.length > 253) return { reason: 'invalid', detail: 'exceeds maximum domain length' };

  const labels = value.split('.');
  if (labels.length < 2) {
    return NON_PUBLIC_SUFFIXES.has(value)
      ? { reason: 'non_public_suffix', detail: `"${value}" does not resolve publicly` }
      : { reason: 'invalid', detail: 'not a fully qualified domain' };
  }

  const suffix = labels[labels.length - 1];
  if (NON_PUBLIC_SUFFIXES.has(suffix)) {
    return { reason: 'non_public_suffix', detail: `".${suffix}" does not resolve publicly` };
  }
  if (DENYLISTED_SUFFIXES.has(suffix)) {
    return { reason: 'denylisted', detail: `".${suffix}" domains are not accepted` };
  }
  if (!labels.every((label) => LABEL.test(label))) {
    return { reason: 'invalid', detail: 'malformed label' };
  }
  if (!TLD.test(suffix)) return { reason: 'invalid', detail: 'malformed top-level domain' };

  return { hostname: value };
};

export interface HostGuardOptions {
  /** Injectable for tests; defaults to the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Additional exact hostnames or suffixes to refuse. */
  denylist?: Iterable<string>;
}

const systemResolve = async (hostname: string): Promise<string[]> => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

const matchesDenylist = (hostname: string, denylist: Set<string>): boolean => {
  if (denylist.has(hostname)) return true;
  const labels = hostname.split('.');
  for (let i = 1; i < labels.length; i += 1) {
    if (denylist.has(labels.slice(i).join('.'))) return true;
  }
  return false;
};

/**
 * Validates a user-supplied host and returns the addresses to connect to.
 *
 * On success the caller MUST connect to one of the returned addresses rather
 * than re-resolving the hostname; see rule 2 in the module header.
 */
export const assertPublicHost = async (
  raw: string,
  options: HostGuardOptions = {},
): Promise<HostGuardResult> => {
  const normalized = normalizeHostname(raw);
  if ('reason' in normalized) {
    return { status: 'rejected', reason: normalized.reason, detail: normalized.detail };
  }
  const { hostname } = normalized;

  const denylist = new Set(options.denylist ?? []);
  if (denylist.size > 0 && matchesDenylist(hostname, denylist)) {
    return { status: 'rejected', reason: 'denylisted', detail: 'host is on the denylist' };
  }

  let addresses: string[];
  try {
    addresses = await (options.resolve ?? systemResolve)(hostname);
  } catch {
    return { status: 'rejected', reason: 'unresolvable', detail: 'host does not resolve' };
  }

  if (addresses.length === 0) {
    return { status: 'rejected', reason: 'unresolvable', detail: 'host resolved to no addresses' };
  }

  // Every address must be public. A host that resolves to one public and one
  // private address is a rebinding attempt, not a misconfiguration.
  const offending = addresses.find((address) => !isPublicAddress(address));
  if (offending) {
    return {
      status: 'rejected',
      reason: 'private_address',
      detail: 'host resolves to a non-public address',
    };
  }

  return { status: 'allowed', hostname, addresses };
};
