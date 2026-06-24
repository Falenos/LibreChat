/**
 * AGK-aware SSRF deny-list for the open_url tool (KK20-194).
 *
 * Why this exists: AGK NetworkPolicy permits same-namespace traffic and a
 * custom egress rule allowing the entire spoke CIDR
 * (10.160.0.0/16 dev, 10.161.0.0/16 prod) to private-endpoint ports for
 * Postgres / Redis / Mongo. A user-pasted URL must never reach these — or any
 * private/link-local/loopback address. Hostnames are resolved here and ALL
 * resolved A/AAAA records are checked. The caller must re-invoke this on
 * every redirect (do not trust an initial pre-check alone).
 */

'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const SPOKE_CIDRS = ['10.160.0.0/16', '10.161.0.0/16'];

const PRIVATE_V4_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function ipv4ToInt(addr) {
  const parts = addr.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function v4InCidr(addr, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base);
  if (a == null || b == null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function isDeniedV4(addr) {
  for (const cidr of SPOKE_CIDRS) {
    if (v4InCidr(addr, cidr)) return true;
  }
  for (const cidr of PRIVATE_V4_CIDRS) {
    if (v4InCidr(addr, cidr)) return true;
  }
  return false;
}

function isDeniedV6(addr) {
  const lower = addr.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80')) return true;
  if (/^f[cd]/.test(lower)) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isDeniedV4(v4);
  }
  return false;
}

/**
 * Returns { allowed: boolean, reason?: string } for a given URL string.
 * Performs DNS resolution and rejects if ANY resolved address is denied.
 * Caller MUST also call this after every redirect.
 */
async function isUrlAllowed(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported_scheme' };
  }
  const host = url.hostname;
  if (!host) return { allowed: false, reason: 'empty_host' };

  if (net.isIPv4(host)) {
    return isDeniedV4(host)
      ? { allowed: false, reason: 'denied_ipv4_literal' }
      : { allowed: true };
  }
  const bareV6 = host.replace(/^\[|\]$/g, '');
  if (net.isIPv6(bareV6)) {
    return isDeniedV6(bareV6)
      ? { allowed: false, reason: 'denied_ipv6_literal' }
      : { allowed: true };
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { allowed: false, reason: 'dns_lookup_failed' };
  }
  if (!records || records.length === 0) {
    return { allowed: false, reason: 'dns_no_records' };
  }
  for (const r of records) {
    if (r.family === 4 && isDeniedV4(r.address)) {
      return { allowed: false, reason: `denied_resolved_ipv4:${r.address}` };
    }
    if (r.family === 6 && isDeniedV6(r.address)) {
      return { allowed: false, reason: `denied_resolved_ipv6:${r.address}` };
    }
  }
  return { allowed: true };
}

module.exports = {
  isUrlAllowed,
  __test__: { isDeniedV4, isDeniedV6, v4InCidr, ipv4ToInt },
};
