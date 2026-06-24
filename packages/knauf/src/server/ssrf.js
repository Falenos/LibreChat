/**
 * AGK-aware SSRF deny-list for the open_url tool (KK20-194).
 *
 * Why this exists: AGK NetworkPolicy permits same-namespace traffic and a
 * custom egress rule allowing the entire spoke CIDR
 * (10.160.0.0/16 dev, 10.161.0.0/16 prod) to private-endpoint ports for
 * Postgres / Redis / Mongo. A user-pasted URL must never reach these — or any
 * private/link-local/loopback address.
 *
 * Parsing/canonicalisation is delegated to `ipaddr.js` (used by Express, well-
 * vetted): it handles every IPv6 form including non-canonical mapped/embedded
 * IPv4 (`::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`, `::ffff:127.0.0.1`). We add:
 *   - the AGK spoke CIDR additions on top of `ipaddr.js`'s standard ranges,
 *   - explicit NAT64 (`64:ff9b::/96`) decoding,
 *   - a single-allowed-address return shape so the caller can pin the actual
 *     undici connection to that IP (closes the DNS-rebinding TOCTOU window).
 *
 * The caller MUST re-invoke this on every redirect.
 */

'use strict';

const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

/**
 * Extra IPv4 CIDRs to deny on top of ipaddr.js's standard ranges (private,
 * loopback, linkLocal, broadcast, carrierGradeNat, reserved, unspecified,
 * multicast). The two spoke ranges are also caught by `private` (10.0.0.0/8),
 * but we keep them explicit so a future shift to a non-10/8 spoke or to a
 * narrower default ruleset would still block them.
 */
const EXTRA_DENY_V4 = ['10.160.0.0/16', '10.161.0.0/16'];

/**
 * IPv4 ranges that `ipaddr.js` classifies as "unicast" but we want to deny
 * anyway. Names match the keys returned by `addr.range()`.
 */
const DENIED_V4_RANGES = new Set([
  'private',
  'loopback',
  'linkLocal',
  'carrierGradeNat',
  'broadcast',
  'reserved',
  'unspecified',
  'multicast',
  'benchmarking',
  'amt',
  'as112',
]);

const DENIED_V6_RANGES = new Set([
  'unspecified',
  'loopback',
  'linkLocal',
  'uniqueLocal',
  'multicast',
  'ipv4Mapped', // covered explicitly below, but extra safety if ipaddr misses a form
  'ipv4Compatible',
  'discard',
  'reserved',
]);

const NAT64_PREFIX = ipaddr.parseCIDR('64:ff9b::/96');

function parseCidrList(cidrs) {
  return cidrs.map((c) => ipaddr.parseCIDR(c));
}
const EXTRA_DENY_V4_PARSED = parseCidrList(EXTRA_DENY_V4);

function isDeniedV4(addrStr) {
  let addr;
  try {
    addr = ipaddr.parse(addrStr);
    if (addr.kind() !== 'ipv4') return true; // unexpected — fail closed
  } catch {
    return true;
  }
  if (DENIED_V4_RANGES.has(addr.range())) return true;
  for (const cidr of EXTRA_DENY_V4_PARSED) {
    if (addr.match(cidr)) return true;
  }
  return false;
}

function isDeniedV6(addrStr) {
  let addr;
  try {
    addr = ipaddr.parse(addrStr);
    if (addr.kind() !== 'ipv6') return true;
  } catch {
    return true;
  }
  // IPv4-mapped (`::ffff:0:0/96`): re-check via the v4 deny-list. ipaddr.js
  // recognises both `::ffff:127.0.0.1` and `::ffff:7f00:1` and exposes the
  // embedded address via toIPv4Address().
  if (addr.isIPv4MappedAddress()) {
    try {
      return isDeniedV4(addr.toIPv4Address().toString());
    } catch {
      return true;
    }
  }
  // NAT64 (`64:ff9b::/96`): decode the embedded v4 manually (ipaddr.js doesn't
  // do this for the well-known NAT64 prefix).
  if (addr.match(NAT64_PREFIX)) {
    const parts = addr.parts;
    const a = (parts[6] >>> 8) & 0xff;
    const b = parts[6] & 0xff;
    const c = (parts[7] >>> 8) & 0xff;
    const d = parts[7] & 0xff;
    return isDeniedV4(`${a}.${b}.${c}.${d}`);
  }
  return DENIED_V6_RANGES.has(addr.range());
}

/**
 * Resolve a URL's hostname and return:
 *   { allowed: true, address, family, host }
 *     - `address`/`family` are the SINGLE resolved record that the caller
 *       MUST pin the actual connection to (close the rebinding TOCTOU).
 *     - `host` is the original hostname (preserve for the Host header / SNI).
 *   { allowed: false, reason }
 *
 * If the host is a literal IP, the literal is returned as the address (after
 * canonicalisation by ipaddr.js so we always pin a clean form). When DNS
 * returns multiple records, ALL are validated and the FIRST allowed record
 * is chosen.
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
  let host = url.hostname;
  if (!host) return { allowed: false, reason: 'empty_host' };
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (ipaddr.isValid(host)) {
    const addr = ipaddr.parse(host);
    if (addr.kind() === 'ipv4') {
      return isDeniedV4(addr.toString())
        ? { allowed: false, reason: 'denied_ipv4_literal' }
        : { allowed: true, address: addr.toString(), family: 4, host };
    }
    // ipv6 literal
    if (isDeniedV6(host)) {
      return { allowed: false, reason: 'denied_ipv6_literal' };
    }
    if (addr.isIPv4MappedAddress()) {
      try {
        return { allowed: true, address: addr.toIPv4Address().toString(), family: 4, host };
      } catch {
        return { allowed: false, reason: 'denied_ipv6_literal' };
      }
    }
    return { allowed: true, address: addr.toNormalizedString(), family: 6, host };
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
  let chosen = null;
  for (const r of records) {
    const denied = r.family === 4 ? isDeniedV4(r.address) : isDeniedV6(r.address);
    if (denied) return { allowed: false, reason: 'denied_resolved_address' };
    if (!chosen) chosen = r;
  }
  return { allowed: true, address: chosen.address, family: chosen.family, host };
}

module.exports = {
  isUrlAllowed,
  __test__: { isDeniedV4, isDeniedV6 },
};

