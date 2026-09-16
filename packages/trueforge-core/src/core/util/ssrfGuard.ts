import type { LookupAllOptions, LookupOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

let allowedHosts: string[] = [];
let blockedHosts: string[] = [];

const URL_VERIFY = {
  allowedProtocols: ['http:', 'https:'],
  denyCidrsV4: [
    '0.0.0.0/8', // this host
    '10.0.0.0/8', // private
    '100.64.0.0/10', // CGNAT (EKS secondary pod CIDRs)
    '127.0.0.0/8', // loopback
    '169.254.0.0/16', // link-local + metadata
    '172.16.0.0/12', // private (docker, k8s service CIDRs)
    '192.0.0.0/24', // IETF protocol assignments
    '192.0.2.0/24', // TEST-NET-1
    '192.88.99.0/24', // 6to4 relay anycast
    '192.168.0.0/16', // private
    '198.18.0.0/15', // benchmarking
    '198.51.100.0/24', // TEST-NET-2
    '203.0.113.0/24', // TEST-NET-3
    '224.0.0.0/4', // multicast
    '240.0.0.0/4', // reserved + broadcast
  ],
  denyCidrsV6: [
    '::/96', // unspecified, ::1, IPv4-compatible
    '64:ff9b::/96', // NAT64 well-known
    '64:ff9b:1::/48', // NAT64 local-use
    '100::/64', // discard-only
    '2001::/32', // Teredo
    '2001:10::/28', // ORCHID
    '2001:20::/28', // ORCHIDv2
    '2001:db8::/32', // documentation
    '2002::/16', // 6to4
    'fc00::/7', // unique-local (IPv6 k8s service CIDRs)
    'fe80::/10', // link-local
    'ff00::/8', // multicast
  ],
  denyHostsExact: ['localhost', 'metadata', 'instance-data', 'metadata.google.internal'],
  denyHostSuffixes: [
    '.local',
    '.localhost',
    '.localdomain',
    '.internal',
    '.svc',
    '.cluster',
    '.arpa',
    '.lan',
    '.intranet',
    '.corp',
    '.home',
    '.test',
    '.invalid',
    '.example',
  ],
};

const privateNets = new BlockList();
function addDenyCidrs(cidrs: readonly string[], family: 'ipv4' | 'ipv6'): void {
  for (const cidr of cidrs) {
    const slash = cidr.lastIndexOf('/');
    privateNets.addSubnet(cidr.slice(0, slash), Number(cidr.slice(slash + 1)), family);
  }
}
addDenyCidrs(URL_VERIFY.denyCidrsV4, 'ipv4');
addDenyCidrs(URL_VERIFY.denyCidrsV6, 'ipv6');

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'host'];

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

function blockedError(host: string, cause?: unknown): Error {
  return new Error(`Outbound URL blocked for host "${host}"`, { cause });
}

function deny(host: string, cause?: unknown): never {
  throw blockedError(host, cause);
}

/** Block/allow lists, k8s hostname shapes, IP literals. Hostname DNS is classified in `guardedLookup`. */
function assertHost(host: string): void {
  if (host === '' || blockedHosts.includes(host)) {
    deny(host);
  }
  if (allowedHosts.includes(host)) {
    return;
  }
  if (isIP(host) === 0) {
    if (
      !host.includes('.') ||
      URL_VERIFY.denyHostsExact.includes(host) ||
      URL_VERIFY.denyHostSuffixes.some(suffix => host.endsWith(suffix))
    ) {
      deny(host);
    }
    return;
  }
  if (isPrivateIp(host)) {
    deny(host);
  }
}

function parseOutboundUrl(input: string | URL | Request): URL {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : input);
  } catch (error) {
    throw new Error('Outbound URL blocked', { cause: error });
  }
  if (!URL_VERIFY.allowedProtocols.includes(url.protocol)) {
    throw new Error('Outbound URL blocked: only http and https are allowed');
  }
  return url;
}

/**
 * undici runs this as the socket lookup, so the addresses we allow are the ones connected to.
 */
const guardedLookup: LookupFunction = (hostname, options: LookupOptions, callback) => {
  const host = normalizeHost(hostname);
  try {
    assertHost(host);
  } catch (error) {
    callback(error instanceof Error ? error : blockedError(host, error), '');
    return;
  }
  if (allowedHosts.includes(host) || isIP(host) !== 0) {
    dnsLookup(hostname, options, callback);
    return;
  }
  const allOptions: LookupAllOptions = { ...options, all: true };
  dnsLookup(hostname, allOptions, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const first = addresses[0];
    if (first === undefined || addresses.some(record => isPrivateIp(record.address))) {
      callback(blockedError(host), '');
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    callback(null, first.address, first.family);
  });
};

const outboundAgent = new Agent({ connect: { lookup: guardedLookup } });

export async function assertSafeOutboundUrl(input: string | URL | Request): Promise<void> {
  const url = parseOutboundUrl(input);
  const host = normalizeHost(url.hostname);
  assertHost(host);
  if (allowedHosts.includes(host) || isIP(host) !== 0) {
    return;
  }
  let addresses: string[];
  try {
    addresses = (await dnsLookupAsync(host, { all: true })).map(record => record.address);
  } catch (error) {
    deny(host, error);
  }
  if (addresses.some(isPrivateIp)) {
    deny(host);
  }
}

function nextHop(
  response: Response,
  location: string,
  current: URL,
  input: string | URL | Request,
  init: RequestInit,
): { url: URL; init: RequestInit } {
  let nextUrl: URL;
  try {
    nextUrl = new URL(location, current);
  } catch (error) {
    throw new Error('Outbound URL blocked', { cause: error });
  }
  if (!URL_VERIFY.allowedProtocols.includes(nextUrl.protocol)) {
    throw new Error('Outbound URL blocked: only http and https are allowed');
  }

  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(init.headers ?? request?.headers);
  let method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  let body = init.body ?? null;
  const downgradesToGet =
    ((response.status === 301 || response.status === 302) && method === 'POST') ||
    (response.status === 303 && method !== 'GET' && method !== 'HEAD');
  if (downgradesToGet) {
    method = 'GET';
    body = null;
    headers.delete('content-encoding');
    headers.delete('content-language');
    headers.delete('content-location');
    headers.delete('content-type');
    headers.delete('content-length');
  }
  if (nextUrl.origin !== current.origin) {
    for (const header of CROSS_ORIGIN_STRIPPED_HEADERS) {
      headers.delete(header);
    }
  }
  return { url: nextUrl, init: { ...init, method, headers, body } };
}

async function guardedFetch(input: string | URL | Request, init: RequestInit, hopsLeft: number): Promise<Response> {
  const url = parseOutboundUrl(input);
  assertHost(normalizeHost(url.hostname));
  const redirect = init.redirect ?? 'follow';
  const followsRedirects = redirect === 'follow';
  const requestInit: RequestInit = {
    ...init,
    redirect: followsRedirects ? 'manual' : redirect,
  };
  // Agent vs undici-types Dispatcher: attach at runtime so fetch still uses this lookup.
  Object.assign(requestInit, { dispatcher: outboundAgent });
  const response = await fetch(url.href, requestInit);
  if (!followsRedirects) {
    return response;
  }
  if (!REDIRECT_STATUSES.has(response.status)) {
    return response;
  }
  const location = response.headers.get('location');
  if (location === null) {
    return response;
  }
  void response.body?.cancel().catch(() => undefined);
  if (hopsLeft === 0) {
    throw new Error('Outbound URL blocked: too many redirects');
  }
  const hop = nextHop(response, location, url, input, init);
  return guardedFetch(hop.url, hop.init, hopsLeft - 1);
}

export async function ssrfFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return guardedFetch(input, init ?? {}, MAX_REDIRECTS);
}
