const IPV4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV4_CIDR_TOKEN_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}\b/g;
const IPV4_TOKEN_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const URL_TOKEN_REGEX = /\bhttps?:\/\/[^\s"'<>)]*/gi;

export interface Ipv4CidrRange {
  baseIp: string;
  prefixLen: number;
  start: number;
  end: number;
}

const PRIVATE_IPV4_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
] as const;

const CLOUD_BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

export const parseIpv4Address = (value: string): number | null => {
  const trimmed = value.trim();
  if (!IPV4_REGEX.test(trimmed)) return null;
  const octets = trimmed.split('.').map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return (
    ((octets[0] << 24) >>> 0) |
    ((octets[1] << 16) >>> 0) |
    ((octets[2] << 8) >>> 0) |
    (octets[3] >>> 0)
  ) >>> 0;
};

const parseIpv4Part = (value: string): number | null => {
  const trimmed = value.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16);
  }
  if (/^0[0-7]+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 8);
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return null;
};

export const parseIpv4AddressLike = (value: string, options?: { allowSingleNumber?: boolean }): number | null => {
  const trimmed = value.trim().toLowerCase();
  const strict = parseIpv4Address(trimmed);
  if (strict !== null) {
    return strict;
  }

  if (options?.allowSingleNumber === true && (/^\d+$/.test(trimmed) || /^0x[0-9a-f]+$/i.test(trimmed))) {
    const parsed = parseIpv4Part(trimmed);
    return parsed !== null && parsed >= 0 && parsed <= 0xffffffff ? parsed >>> 0 : null;
  }

  const parts = trimmed.split('.');
  if (parts.length < 2 || parts.length > 4) {
    return null;
  }

  const parsed = parts.map(parseIpv4Part);
  if (parsed.some((part) => part === null)) {
    return null;
  }
  const numbers = parsed as number[];

  if (numbers.length === 2) {
    const [a, b] = numbers;
    return a <= 0xff && b <= 0xffffff ? (((a << 24) >>> 0) | (b >>> 0)) >>> 0 : null;
  }
  if (numbers.length === 3) {
    const [a, b, c] = numbers;
    return a <= 0xff && b <= 0xff && c <= 0xffff
      ? (((a << 24) >>> 0) | ((b << 16) >>> 0) | (c >>> 0)) >>> 0
      : null;
  }

  const [a, b, c, d] = numbers;
  return numbers.every((part) => part >= 0 && part <= 0xff)
    ? (((a << 24) >>> 0) | ((b << 16) >>> 0) | ((c << 8) >>> 0) | (d >>> 0)) >>> 0
    : null;
};

export const parseIpv4CidrRange = (value: string): Ipv4CidrRange | null => {
  const [baseIpRaw, prefixRaw] = value.trim().split('/');
  if (!baseIpRaw || prefixRaw === undefined) {
    return null;
  }

  const prefixLen = Number.parseInt(prefixRaw, 10);
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    return null;
  }

  const baseInt = parseIpv4Address(baseIpRaw);
  if (baseInt === null) {
    return null;
  }

  const mask = prefixLen === 0 ? 0 : prefixLen === 32 ? 0xffffffff : (0xffffffff << (32 - prefixLen)) >>> 0;
  const start = prefixLen === 0 ? 0 : (baseInt & mask) >>> 0;
  const hostBits = prefixLen === 32 ? 0 : (0xffffffff >>> prefixLen) >>> 0;
  const end = (start | hostBits) >>> 0;

  return {
    baseIp: baseIpRaw,
    prefixLen,
    start,
    end,
  };
};

export const isValidIpv4Cidr = (value: string): boolean => parseIpv4CidrRange(value) !== null;

export const isIpv4InCidr = (ip: string, cidr: string): boolean => {
  const ipInt = parseIpv4Address(ip);
  const range = parseIpv4CidrRange(cidr);
  return ipInt !== null && range !== null && ipInt >= range.start && ipInt <= range.end;
};

export const isIpv4CidrContainedIn = (cidr: string, containerCidr: string): boolean => {
  const range = parseIpv4CidrRange(cidr);
  const container = parseIpv4CidrRange(containerCidr);
  if (!range || !container) {
    return false;
  }
  return range.start >= container.start && range.end <= container.end;
};

export const doesIpv4CidrOverlap = (cidr: string, containerCidr: string): boolean => {
  const range = parseIpv4CidrRange(cidr);
  const container = parseIpv4CidrRange(containerCidr);
  if (!range || !container) {
    return false;
  }
  return range.start <= container.end && container.start <= range.end;
};

export const isPrivateIpv4CidrTarget = (cidr: string): boolean =>
  PRIVATE_IPV4_CIDRS.some((container) => isIpv4CidrContainedIn(cidr, container));

export const isCloudBlockedIpv4CidrTarget = (cidr: string): boolean =>
  CLOUD_BLOCKED_IPV4_CIDRS.some((container) => doesIpv4CidrOverlap(cidr, container));

export const isCloudBlockedIpv4Address = (ip: string): boolean =>
  CLOUD_BLOCKED_IPV4_CIDRS.some((container) => isIpv4InCidr(ip, container));

export const isCloudBlockedIpv4AddressLike = (
  value: string,
  options?: { allowSingleNumber?: boolean },
): boolean => {
  const ipInt = parseIpv4AddressLike(value, options);
  if (ipInt === null) {
    return false;
  }
  return CLOUD_BLOCKED_IPV4_CIDRS.some((container) => {
    const range = parseIpv4CidrRange(container);
    return range !== null && ipInt >= range.start && ipInt <= range.end;
  });
};

const normalizeHostCandidate = (value: string): string =>
  value.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

export const isCloudBlockedHost = (value: string): boolean => {
  const host = normalizeHostCandidate(value);
  if (!host) {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (isCloudBlockedIpv4AddressLike(host, { allowSingleNumber: true })) {
    return true;
  }
  if (host === '::1' || host.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    return true;
  }
  const ipv4Mapped = host.match(/(?:::ffff:|:ffff:)(?<ip>(?:\d{1,3}\.){3}\d{1,3})$/i);
  if (ipv4Mapped?.groups?.ip && isCloudBlockedIpv4Address(ipv4Mapped.groups.ip)) {
    return true;
  }
  const ipv4MappedHex = host.match(/(?:::ffff:|:ffff:)(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})$/i);
  if (ipv4MappedHex?.groups?.high && ipv4MappedHex.groups.low) {
    const ipInt = ((Number.parseInt(ipv4MappedHex.groups.high, 16) << 16) | Number.parseInt(ipv4MappedHex.groups.low, 16)) >>> 0;
    return CLOUD_BLOCKED_IPV4_CIDRS.some((container) => {
      const range = parseIpv4CidrRange(container);
      return range !== null && ipInt >= range.start && ipInt <= range.end;
    });
  }
  return false;
};

export const findCloudBlockedNetworkTargetInUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    return isCloudBlockedHost(parsed.hostname) ? parsed.hostname : null;
  } catch {
    return null;
  }
};

/** The host exactly as written in a URL token, before any parser normalizes it. */
const rawHostOfUrlToken = (token: string): string | null => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?(?<host>\[[^\]]+\]|[^/:?#]+)/iu.exec(token);
  return match?.groups?.host ?? null;
};

const commandReferencesBlockedIpv6OrLocalhost = (command: string): string[] => {
  const matches = new Set<string>();
  if (/\blocalhost(?:\.localhost)?\b/i.test(command)) {
    matches.add('localhost');
  }
  if (/(^|[^:\da-f])::1([^:\da-f]|$)/i.test(command)) {
    matches.add('::1');
  }
  if (/\bfc[0-9a-f]{2}:/i.test(command) || /\bfd[0-9a-f]{2}:/i.test(command)) {
    matches.add('fc00::/7');
  }
  if (/\bfe80:/i.test(command)) {
    matches.add('fe80::/10');
  }
  const mappedIpv4 = command.match(/(?:::ffff:|:ffff:)((?:\d{1,3}\.){3}\d{1,3})/gi) ?? [];
  for (const match of mappedIpv4) {
    const ip = match.split(':').pop();
    if (ip && isCloudBlockedIpv4Address(ip)) {
      matches.add(match);
    }
  }
  return [...matches];
};

/**
 * Shell-ish tokenization, good enough to tell a destination argument from a version string.
 *
 * The guard used to run its regexes over every byte of the raw command. A browser
 * User-Agent containing `Windows NT 10.0` was therefore read as the private network
 * `10.0.0.0/8`, because the legacy `inet_aton` two-part form expands `10.0` to `10.0.0.0`.
 * That rejected an ordinary enumeration command in production run r1.
 *
 * Strict forms stay globally scanned — a dotted quad, a CIDR block or a URL means one thing
 * wherever it appears. Only the ambiguous shorthand forms need to be in a host position.
 */
interface ShellToken {
  value: string;
  /** True when the token came from inside quotes, so it is prose or a payload, not a host. */
  quoted: boolean;
  /** The token before it in the same command, or undefined at the start of one. */
  previous: string | undefined;
  /** The command word this token belongs to, e.g. `curl`. */
  commandWord: string | undefined;
}

const SHELL_OPERATORS = new Set(['|', '&', ';', '(', ')', '{', '}']);

/** Commands whose positional arguments are network destinations. */
const NETWORK_COMMAND_WORDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync',
  'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'dig', 'host', 'nslookup', 'whois',
  'nmap', 'naabu', 'masscan', 'httpx', 'nuclei', 'ffuf', 'gobuster', 'katana', 'subfinder',
  'openssl', 'sslscan', 'testssl.sh', 'hydra', 'redis-cli', 'psql', 'mysql', 'mongosh',
]);

/** Flags whose immediate value is a network destination. */
const HOST_BEARING_FLAGS = new Set([
  '-u', '--url', '-h', '--host', '--target', '--targets', '-t', '--connect-to', '--resolve',
  '-x', '--proxy', '--socks5', '--socks4', '--socks5-hostname', '--interface', '--dns-servers',
  '--upstream', '--remote', '--server', '-H2', '--sni',
]);

const tokenizeCommand = (command: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  let buffer = '';
  let bufferQuoted = false;
  let quote: '"' | "'" | undefined;
  let previous: string | undefined;
  let commandWord: string | undefined;
  let expectCommandWord = true;

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (expectCommandWord) {
      commandWord = buffer.toLowerCase().split('/').pop();
      expectCommandWord = false;
    }
    tokens.push({ value: buffer, quoted: bufferQuoted, previous, commandWord });
    previous = buffer;
    buffer = '';
    bufferQuoted = false;
  };

  const breakCommand = (): void => {
    flush();
    previous = undefined;
    commandWord = undefined;
    expectCommandWord = true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        buffer += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      bufferQuoted = true;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      buffer += command[index + 1]!;
      index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      if (char === '\n' || char === '\r') {
        breakCommand();
      } else {
        flush();
      }
      continue;
    }
    if (SHELL_OPERATORS.has(char)) {
      breakCommand();
      continue;
    }
    buffer += char;
  }
  flush();
  return tokens;
};

/** Strips a trailing `:port`, so `10.0:8080` is still recognised as the host `10.0`. */
const stripPort = (value: string): string => {
  const match = /^(?<host>.+):(?<port>\d{1,5})$/u.exec(value);
  return match?.groups?.host ?? value;
};

/**
 * True when this token sits where a host belongs: the value of a host-bearing flag, or a
 * positional argument of a network command. A token preceded by any other flag is that
 * flag's value — `curl --max-time 10.0` is a timeout, not a destination.
 */
const isHostPosition = (token: ShellToken): boolean => {
  if (token.quoted) return false;
  const previous = token.previous;
  if (previous !== undefined && previous.startsWith('-')) {
    return HOST_BEARING_FLAGS.has(previous.toLowerCase());
  }
  if (token.commandWord === undefined) return false;
  return NETWORK_COMMAND_WORDS.has(token.commandWord) && token.value !== token.commandWord;
};

const AMBIGUOUS_LOOSE_DOTTED = /^(?:0x[0-9a-f]+|0[0-7]+|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+)){1,3}$/iu;
const AMBIGUOUS_HEX = /^0x[0-9a-f]{7,8}$/iu;
const AMBIGUOUS_DECIMAL = /^(?:1\d{9}|2\d{9}|3\d{9}|4[0-2]\d{8})$/u;

export const findCloudBlockedNetworkTargetsInCommand = (command: string): string[] => {
  const blocked = new Set<string>(commandReferencesBlockedIpv6OrLocalhost(command));

  // Unambiguous forms: a URL, a CIDR block or a dotted quad means a destination wherever it
  // appears, including inside a quoted payload.
  for (const match of command.match(URL_TOKEN_REGEX) ?? []) {
    const target = findCloudBlockedNetworkTargetInUrl(match);
    if (target) {
      blocked.add(target);
      // `new URL()` normalizes `0x7f000001` to `127.0.0.1`. Report the form the operator
      // actually wrote as well, so the refusal names something they can find in their command.
      const written = rawHostOfUrlToken(match);
      if (written && written.toLowerCase() !== target.toLowerCase()) {
        blocked.add(written);
      }
    }
  }
  for (const match of command.match(IPV4_CIDR_TOKEN_REGEX) ?? []) {
    if (isCloudBlockedIpv4CidrTarget(match)) {
      blocked.add(match);
    }
  }
  for (const match of command.match(IPV4_TOKEN_REGEX) ?? []) {
    if (isCloudBlockedIpv4Address(match)) {
      blocked.add(match);
    }
  }

  // Ambiguous shorthand: only where the shell says a host belongs.
  for (const token of tokenizeCommand(command)) {
    if (!isHostPosition(token)) continue;
    const candidate = stripPort(token.value);
    if (AMBIGUOUS_LOOSE_DOTTED.test(candidate)) {
      if (isCloudBlockedIpv4AddressLike(candidate)) {
        blocked.add(candidate);
      }
      continue;
    }
    if (AMBIGUOUS_HEX.test(candidate) || AMBIGUOUS_DECIMAL.test(candidate)) {
      if (isCloudBlockedIpv4AddressLike(candidate, { allowSingleNumber: true })) {
        blocked.add(candidate);
      }
    }
  }

  return [...blocked].sort();
};
