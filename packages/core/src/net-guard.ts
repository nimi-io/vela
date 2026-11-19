import net from "node:net";
import dns from "node:dns";

/**
 * SSRF protection for user-supplied URLs (asset inputs, subtitle/overlay URLs, webhooks).
 *
 * Hostname pattern checks are not enough: a public DNS name can resolve to 127.0.0.1, a redirect
 * can point at the metadata service, and a name can re-resolve between a check and the connect
 * (DNS rebinding). So the address that is actually connected to is checked: `guardedLookup` is
 * passed as the `lookup` option of http(s).request, and literal IPs are checked up front.
 *
 * Set ALLOW_PRIVATE_INPUT_URLS=true to allow private destinations (local development).
 */

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches localhost on Linux
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(addr, prefix, "ipv6");
}

/** IPv4 address embedded in an IPv6 address that routes to it (mapped, compatible, NAT64, 6to4). */
function embeddedIpv4(ip6: string): string | null {
  const full = expandIpv6(ip6);
  if (!full) return null;
  const words = full.split(":").map((w) => parseInt(w, 16));
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeros = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible), ::ffff:0:a.b.c.d (translated)
  if (zeros(0, 5) && (words[5] === 0xffff || words[5] === 0)) return v4(words[6]!, words[7]!);
  if (zeros(0, 4) && words[4] === 0xffff && words[5] === 0) return v4(words[6]!, words[7]!);
  // 64:ff9b::a.b.c.d (NAT64) and 64:ff9b:1::/48
  if (words[0] === 0x64 && words[1] === 0xff9b) return v4(words[6]!, words[7]!);
  // 2002:AABB:CCDD::/16 (6to4)
  if (words[0] === 0x2002) return v4(words[1]!, words[2]!);
  return null;
}

function expandIpv6(ip: string): string | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  // Trailing dotted quad → two hex words.
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const p = m[2]!.split(".").map(Number);
    s = `${m[1]}${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const words = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (words.length !== 8) return null;
  return words.map((w) => w.padStart(4, "0")).join(":");
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved… (IPv4 or IPv6). */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4 && blocked.check(v4, "ipv4")) return true;
    return blocked.check(ip.split("%")[0]!, "ipv6");
  }
  return true; // not an IP at all: treat as unsafe
}

export function privateUrlsAllowed() {
  return ["1", "true", "yes", "on"].includes(String(process.env.ALLOW_PRIVATE_INPUT_URLS ?? "").toLowerCase());
}

export class BlockedUrlError extends Error {}

/** Normalised hostname: no IPv6 brackets, no trailing dot, lower case. */
export function bareHost(hostname: string) {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Synchronous checks that need no DNS: scheme, credentials-free http(s), literal private IPs and
 * names that always mean "this machine". Throws BlockedUrlError.
 */
export function assertSafeUrlSyntax(raw: string, opts: { allowPrivate?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError("must be a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError(`URL scheme ${u.protocol} is not supported (use http or https)`);
  if (opts.allowPrivate ?? privateUrlsAllowed()) return u;
  const host = bareHost(u.hostname);
  if (!host || host === "localhost" || host.endsWith(".localhost")) throw new BlockedUrlError(`URL host ${u.hostname} is not allowed`);
  if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError(`URL host ${u.hostname} is a private address`);
  return u;
}

/** Full check including DNS resolution (every address the name resolves to must be public). */
export async function assertPublicUrl(raw: string, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
  const u = assertSafeUrlSyntax(raw, opts);
  if (opts.allowPrivate ?? privateUrlsAllowed()) return u;
  const host = bareHost(u.hostname);
  if (net.isIP(host)) return u;
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    // Unresolvable now; the fetch-time lookup guard decides when it is actually used.
    return u;
  }
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new BlockedUrlError(`URL host ${u.hostname} resolves to a private address (${bad.address})`);
  return u;
}

/**
 * Drop-in `lookup` for http(s).request/net.connect that refuses private addresses, so the check
 * applies to the address actually connected to (no DNS-rebinding window between check and use).
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...(options as dns.LookupOptions), all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad) {
      return (callback as any)(new BlockedUrlError(`URL host ${hostname} resolves to a private address (${bad.address})`));
    }
    if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
    (callback as any)(null, list[0]!.address, list[0]!.family);
  });
};
