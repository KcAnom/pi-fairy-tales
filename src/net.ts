/** SSRF-aware URL fetching for the web tool. */
import { lookup } from "node:dns/promises";

function ipIsPrivate(ip: string): boolean {
  // IPv6
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true; // link-local, unique-local
    if (low.startsWith("::ffff:")) return ipIsPrivate(low.slice(7)); // IPv4-mapped
    return false;
  }
  // IPv4
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 127 || a === 0 || a === 10) return true; // loopback, this-network, private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

async function assertSafeHost(hostname: string): Promise<void> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    throw new Error(`fetch blocked: ${hostname} is a local/internal host`);
  }
  // Literal IP?
  if (/^[\d.]+$/.test(h) || h.includes(":")) {
    if (ipIsPrivate(h)) throw new Error(`fetch blocked: ${hostname} resolves to a private/loopback address`);
    return;
  }
  // Resolve and check every address.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(h, { all: true });
  } catch (err) {
    throw new Error(`fetch blocked: could not resolve ${hostname} (${String(err)})`);
  }
  for (const { address } of addrs) {
    if (ipIsPrivate(address)) throw new Error(`fetch blocked: ${hostname} resolves to private address ${address}`);
  }
}

export interface SafeFetchResult {
  status: number;
  statusText: string;
  headers: Headers;
  /** Body text, capped at maxBytes (streamed — the download aborts past the cap). */
  text: string;
  truncated: boolean;
  finalUrl: string;
}

/**
 * Fetch with SSRF protection: manually follows redirects, re-checking the host
 * of every hop, and streams the body so an oversized response is aborted at
 * maxBytes rather than fully buffered.
 */
export async function safeFetch(
  url: string,
  opts: { signal: AbortSignal; maxBytes: number; blockPrivate: boolean; headers?: Record<string, string> },
): Promise<SafeFetchResult> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    if (opts.blockPrivate) await assertSafeHost(u.hostname);

    const res = await fetch(current, {
      signal: opts.signal,
      redirect: "manual",
      headers: opts.headers,
    });

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${current}`);

    // Stream, enforcing the byte cap.
    const reader = res.body?.getReader();
    let received = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          if (received >= opts.maxBytes) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text: buf.toString("utf-8"),
      truncated,
      finalUrl: current,
    };
  }
  throw new Error(`fetch blocked: too many redirects starting from ${url}`);
}
