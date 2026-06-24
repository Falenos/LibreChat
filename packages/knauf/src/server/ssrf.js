/**
 * AGK-aware SSRF deny-list for the open_url tool (KK20-194).
 *
 * Why this exists: AGK NetworkPolicy permits same-namespace traffic and a
 * custom egress rule allowing the entire spoke CIDR
 * (10.160.0.0/16 dev, 10.161.0.0/16 prod) to private-endpoint ports for
 * Postgres / Redis / Mongo. A user-pasted URL must never reach these — or any
 * private/link-local/loopback address. The hostname is resolved here and
 * **all** resolved A/AAAA records are checked; the caller then pins the
 * connection to the chosen IP via an undici Agent so undici cannot resolve
 * again (closes the DNS-rebinding TOCTOU window).
 *
 * IPv4-mapped IPv6 (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) are
 * canonicalised back to IPv4 before the deny-list runs, regardless of whether
 * the WHATWG URL parser emits the dotted form (`::ffff:127.0.0.1`) or the
 * compressed hex form (`::ffff:7f00:1`).
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
  '255.255.255.255/32',
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
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
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

/**
 * Expand an IPv6 address into 8 16-bit groups (numbers). Returns null on
 * parse failure. Handles `::` compression and the dotted-quad trailer used by
 * IPv4-mapped / IPv4-compatible forms.
 */
function expandV6(addr) {
  if (typeof addr !== 'string') return null;
  let s = addr.toLowerCase().replace(/^\[|\]$/g, '');
  // Drop a zone id if present (`fe80::1%eth0`).
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);

  // Dotted-quad trailer (`::ffff:127.0.0.1`) → two hex groups.
  const lastColon = s.lastIndexOf(':');
  if (lastColon >= 0 && s.slice(lastColon + 1).includes('.')) {
    const v4 = s.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const v4int = ipv4ToInt(v4);
    if (v4int == null) return null;
    const hi = ((v4int >>> 16) & 0xffff).toString(16);
    const lo = (v4int & 0xffff).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fillCount = 8 - (left.length + right.length);
  if (halves.length === 1 && fillCount !== 0) return null;
  if (halves.length === 2 && fillCount < 0) return null;
  const groups = [...left, ...Array(Math.max(fillCount, 0)).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const parsed = groups.map((g) => {
    if (g.length === 0 || g.length > 4) return NaN;
    const n = parseInt(g, 16);
    return Number.isNaN(n) || /[^0-9a-f]/i.test(g) ? NaN : n;
  });
  if (parsed.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return parsed;
}

/**
 * If the IPv6 address is in a v4-bearing prefix (mapped `::ffff:0:0/96`,
 * deprecated v4-compatible `::/96`, or NAT64 `64:ff9b::/96`), return the
 * embedded IPv4 dotted-quad. Otherwise return null.
 */
function embeddedV4(addr) {
  const g = expandV6(addr);
  if (!g) return null;
  const isMapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  const isNat64 = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  // Deprecated v4-compatible `::a.b.c.d` (all-zero first 96 bits, non-zero v4).
  const isCompat =
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && (g[6] !== 0 || g[7] !== 0);
  if (!(isMapped || isNat64 || isCompat)) return null;
  const a = (g[6] >>> 8) & 0xff;
  const b = g[6] & 0xff;
  const c = (g[7] >>> 8) & 0xff;
  const d = g[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function isDeniedV6(addr) {
  const g = expandV6(addr);
  if (!g) {
    // Could not parse — fail closed.
    return true;
  }
  // Embedded v4 (mapped, v4-compat, NAT64): re-check via v4 deny-list.
  const v4 = embeddedV4(addr);
  if (v4) {
    return isDeniedV4(v4);
  }
  // Unspecified `::`.
  if (g.every((x) => x === 0)) return true;
  // Loopback `::1`.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true;
  }
  // Link-local `fe80::/10`.
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // Unique-local `fc00::/7`.
  if ((g[0] & 0xfe00) === 0xfc00) return true;
  // Multicast `ff00::/8`.
  if ((g[0] & 0xff00) === 0xff00) return true;
  return false;
}

/**
 * Resolve a URL's hostname and return:
 *   { allowed: true, address, family, host, url }
 *     - `address`/`family` are the SINGLE resolved record that the caller
 *       MUST pin the actual connection to (close the rebinding TOCTOU).
 *     - `host` is the original hostname (preserve for the Host header / SNI).
 *   { allowed: false, reason }
 *
 * If the host is a literal IP, the literal is returned as the address.
 * If DNS returns multiple records, the FIRST one is chosen — all records are
 * validated; if any is denied the URL is rejected outright.
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
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (net.isIPv4(host)) {
    return isDeniedV4(host)
      ? { allowed: false, reason: 'denied_ipv4_literal' }
      : { allowed: true, address: host, family: 4, host };
  }
  if (net.isIPv6(host)) {
    if (isDeniedV6(host)) {
      return { allowed: false, reason: 'denied_ipv6_literal' };
    }
    // Embedded v4 already checked inside isDeniedV6; expose the canonical
    // v4 to the caller so it can pin via IPv4 too.
    const v4 = embeddedV4(host);
    if (v4) {
      return { allowed: true, address: v4, family: 4, host };
    }
    return { allowed: true, address: host, family: 6, host };
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
    if (r.family === 4) {
      if (isDeniedV4(r.address)) {
        return { allowed: false, reason: 'denied_resolved_address' };
      }
    } else if (r.family === 6) {
      if (isDeniedV6(r.address)) {
        return { allowed: false, reason: 'denied_resolved_address' };
      }
    }
    if (!chosen) chosen = r;
  }
  return { allowed: true, address: chosen.address, family: chosen.family, host };
}

module.exports = {
  isUrlAllowed,
  __test__: { isDeniedV4, isDeniedV6, v4InCidr, ipv4ToInt, expandV6, embeddedV4 },
};

