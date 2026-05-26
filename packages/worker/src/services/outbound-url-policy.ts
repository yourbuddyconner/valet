import { ValidationError } from '@valet/shared';

export interface OutboundUrlPolicyOptions {
  resolveHost?: (hostname: string) => Promise<string[]>;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

export async function validateOutboundUrl(
  input: string | URL,
  options: OutboundUrlPolicyOptions = {},
): Promise<URL> {
  const url = input instanceof URL ? new URL(input.href) : parseUrl(input);

  if (url.protocol !== 'https:') {
    throw new ValidationError('Outbound connector URLs must use https.');
  }
  if (url.username || url.password) {
    throw new ValidationError('Outbound connector URLs must not include credentials.');
  }
  if (url.hash) {
    throw new ValidationError('Outbound connector URLs must not include fragments.');
  }
  if (url.port && url.port !== '443') {
    throw new ValidationError('Outbound connector URLs must use the default HTTPS port.');
  }

  const hostname = normalizeHostname(url.hostname);
  validateHostname(hostname);

  if (options.resolveHost) {
    const addresses = await options.resolveHost(hostname);
    if (addresses.length === 0) {
      throw new ValidationError(`Outbound connector host "${hostname}" did not resolve to any addresses.`);
    }
    for (const address of addresses) {
      validateResolvedAddress(address, hostname);
    }
  }

  return url;
}

function parseUrl(input: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new ValidationError('Outbound connector URL is invalid.');
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function validateHostname(hostname: string): void {
  if (!hostname) {
    throw new ValidationError('Outbound connector URL host is required.');
  }
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new ValidationError(`Outbound connector host "${hostname}" is not allowed.`);
  }
  if (!hostname.includes('.')) {
    throw new ValidationError(`Outbound connector host "${hostname}" is not allowed.`);
  }
  if (parseIPv4(hostname) || parseIPv6(hostname)) {
    throw new ValidationError('Outbound connector IP literals are not allowed; use a public DNS hostname.');
  }
}

function validateResolvedAddress(address: string, hostname: string): void {
  const normalized = normalizeHostname(address);
  const ipv4 = parseIPv4(normalized);
  if (ipv4) {
    if (!isPublicIPv4(ipv4)) {
      throw new ValidationError(`Outbound connector host "${hostname}" resolved to a non-public address and is not allowed.`);
    }
    return;
  }

  const ipv6 = parseIPv6(normalized);
  if (ipv6) {
    const mapped = getIPv4MappedAddress(ipv6);
    if (mapped) {
      if (!isPublicIPv4(mapped)) {
        throw new ValidationError(`Outbound connector host "${hostname}" resolved to a non-public address and is not allowed.`);
      }
      return;
    }

    if (!isPublicIPv6(ipv6)) {
      throw new ValidationError(`Outbound connector host "${hostname}" resolved to a non-public address and is not allowed.`);
    }
    return;
  }

  throw new ValidationError(`Outbound connector host "${hostname}" resolved to an invalid address.`);
}

function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : Number.NaN;
  });
  return octets.some(Number.isNaN) ? null : octets;
}

function ipv4ToInt(octets: number[]): number {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function inIPv4Range(octets: number[], cidrBase: string, bits: number): boolean {
  const base = parseIPv4(cidrBase);
  if (!base) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(octets) & mask) === (ipv4ToInt(base) & mask);
}

function isPublicIPv4(octets: number[]): boolean {
  const blocked: Array<[string, number]> = [
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
  return !blocked.some(([base, bits]) => inIPv4Range(octets, base, bits));
}

function parseIPv6(value: string): number[] | null {
  let input = value.toLowerCase();
  const zoneIndex = input.indexOf('%');
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);
  if (!input.includes(':')) return null;

  let ipv4Tail: number[] | null = null;
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    ipv4Tail = parseIPv4(tail);
    if (!ipv4Tail) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16)}:${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const parseGroup = (group: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    return parseInt(group, 16);
  };

  const leftGroups = left.map(parseGroup);
  const rightGroups = right.map(parseGroup);
  if (leftGroups.some((g) => g === null) || rightGroups.some((g) => g === null)) return null;

  const present = leftGroups.length + rightGroups.length;
  if (halves.length === 1) {
    if (present !== 8) return null;
    return leftGroups as number[];
  }

  const zeroCount = 8 - present;
  if (zeroCount < 1) return null;
  return [
    ...(leftGroups as number[]),
    ...Array.from({ length: zeroCount }, () => 0),
    ...(rightGroups as number[]),
  ];
}

function getIPv4MappedAddress(groups: number[]): number[] | null {
  const isMapped = groups[0] === 0
    && groups[1] === 0
    && groups[2] === 0
    && groups[3] === 0
    && groups[4] === 0
    && groups[5] === 0xffff;
  if (!isMapped) return null;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
}

function isPublicIPv6(groups: number[]): boolean {
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const first = groups[0];
  if (allZero || loopback) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  return true;
}
