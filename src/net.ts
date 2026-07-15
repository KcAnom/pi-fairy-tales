/** SSRF-aware URL fetching for the web tool. */
import { lookup } from "node:dns/promises";
import type { Agent as UndiciAgent, Dispatcher } from "undici";

/**
 * Is this IP address private/loopback/reserved (i.e. must never be the
 * connection target of a `safeFetch`)? Conservative: malformed input returns
 * true (block) rather than false, so a weird address can't slip past SSRF
 * checks. Exported so the classification is unit-testable.
 */
export function ipIsPrivate(ip: string): boolean {
  // IPv6
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true; // link-local, unique-local
    if (low.startsWith("::ffff:")) return ipIsPrivate(low.slice(7)); // IPv4-mapped
    return false;
  }
  // IPv4 — malformed input is treated as reserved so it can't bypass the check.
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 127 || a === 0 || a === 10) return true; // loopback, this-network, private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Reject local hostnames and any address that resolves to a private/loopback IP.
 * Returns the list of verified *public* addresses for the hostname, so the
 * caller can pin the connection to exactly those addresses (closing the
 * DNS-rebinding window: without pinning, `fetch()` re-resolves and a malicious
 * server could hand back a private IP between this check and the connect).
 */
async function assertSafeHost(hostname: string): Promise<string[]> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    throw new Error(`fetch blocked: ${hostname} is a local/internal host`);
  }
  // Literal IP?
  if (/^[\d.]+$/.test(h) || h.includes(":")) {
    if (ipIsPrivate(h)) throw new Error(`fetch blocked: ${hostname} resolves to a private/loopback address`);
    return [h];
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
  return addrs.map((a) => a.address);
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
 *
 * DNS-rebinding defense: when `blockPrivate` is set, after resolving and
 * verifying the hostname's public addresses, we install a custom DNS `lookup`
 * on a one-shot dispatcher that only ever returns one of the *pre-verified*
 * addresses — so even if the authoritative server flips to a private IP between
 * the check and the connect, the connection is refused instead.
 */
export async function safeFetch(
  url: string,
  opts: { signal: AbortSignal; maxBytes: number; blockPrivate: boolean; headers?: Record<string, string> },
): Promise<SafeFetchResult> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(current);
    const allowed = opts.blockPrivate ? await assertSafeHost(u.hostname) : [];

    // Build a pinned dispatcher for this hop (one-shot, closed in `finally`).
    // undici is dynamically imported: Node bundles it internally for its own
    // fetch, but the bare `undici` specifier is only resolvable when present in
    // node_modules. If it isn't, we fall back to the global fetch with no
    // pinning (the assertSafeHost check above still runs) rather than crashing.
    let dispatcher: Dispatcher | undefined;
    if (opts.blockPrivate && allowed.length > 0) {
      try {
        const { Agent } = (await import("undici")) as { Agent: new (opts: { connect: { lookup: Dispatcher.LookupCallback } }) => UndiciAgent };
        const allowedSet = new Set(allowed);
        dispatcher = new Agent({
          connect: {
            lookup: (_host, _opts, cb) => {
              // Re-resolve and only accept an address we pre-verified as public.
              lookup(u.hostname, { all: true })
                .then((addrs) => {
                  const safe = addrs.find((a) => allowedSet.has(a.address));
                  if (safe) cb(null, [{ address: safe.address, family: safe.family }]);
                  else cb(new Error(`fetch blocked: DNS rebinding detected — ${u.hostname} resolved to an unverified address`));
                })
                .catch((err) => cb(err as Error));
            },
          },
        });
      } catch {
        // undici not resolvable — proceed without a pinned dispatcher.
      }
    }

    try {
      const res = await fetch(current, {
        signal: opts.signal,
        redirect: "manual",
        headers: opts.headers,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);

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
    } finally {
      if (dispatcher) await dispatcher.close().catch(() => {});
    }
  }
  throw new Error(`fetch blocked: too many redirects starting from ${url}`);
}
