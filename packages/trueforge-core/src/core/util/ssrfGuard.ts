import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

let allowedHosts: string[] = [];
let blockedHosts: string[] = [];

const privateNets = new BlockList();
privateNets.addSubnet('0.0.0.0', 8, 'ipv4');
privateNets.addSubnet('10.0.0.0', 8, 'ipv4');
privateNets.addSubnet('127.0.0.0', 8, 'ipv4');
privateNets.addSubnet('169.254.0.0', 16, 'ipv4');
privateNets.addSubnet('172.16.0.0', 12, 'ipv4');
privateNets.addSubnet('192.168.0.0', 16, 'ipv4');
privateNets.addSubnet('::', 128, 'ipv6');
privateNets.addSubnet('::1', 128, 'ipv6');
privateNets.addSubnet('fc00::', 7, 'ipv6');
privateNets.addSubnet('fe80::', 10, 'ipv6');

export function configureOutboundUrlGuard(config: {
  allowedHosts: readonly string[];
  blockedHosts: readonly string[];
}): void {
  allowedHosts = config.allowedHosts.map(normalizeHost);
  blockedHosts = config.blockedHosts.map(normalizeHost);
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/\.$/, '').toLowerCase();
}

function isPrivateIp(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) {
    return privateNets.check(ip, 'ipv4');
  }
  if (isIP(ip) === 6) {
    return privateNets.check(ip, 'ipv6');
  }
  return true;
}

function deny(host: string, cause?: unknown): never {
  throw new Error(`Outbound URL blocked for host "${host}"`, { cause });
}

export async function assertSafeOutboundUrl(input: string | URL | Request): Promise<void> {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : input);
  } catch (error) {
    throw new Error('Outbound URL blocked', { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Outbound URL blocked: only http and https are allowed');
  }

  const host = normalizeHost(url.hostname);
  if (host === '' || blockedHosts.includes(host)) {
    deny(host);
  }
  if (allowedHosts.includes(host)) {
    return;
  }

  let addresses: string[];
  try {
    addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map(record => record.address);
  } catch (error) {
    deny(host, error);
  }
  if (addresses.some(isPrivateIp)) {
    deny(host);
  }
}

export async function ssrfFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  await assertSafeOutboundUrl(input);
  return fetch(input, init);
}
