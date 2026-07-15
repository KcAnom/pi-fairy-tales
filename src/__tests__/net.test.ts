/**
 * Tests for src/net.ts — SSRF guard classification.
 * `ipIsPrivate` is the core of the SSRF defense (used by assertSafeHost); these
 * tests pin every reserved IPv4/IPv6 range and the conservative "block on
 * malformed input" policy so a classification bug can't open a bypass.
 */
import { describe, it, expect } from "vitest";
import { ipIsPrivate } from "../net.ts";

describe("ipIsPrivate — IPv4 reserved ranges", () => {
  it("blocks loopback (127.0.0.0/8)", () => {
    expect(ipIsPrivate("127.0.0.1")).toBe(true);
    expect(ipIsPrivate("127.255.255.255")).toBe(true);
    expect(ipIsPrivate("127.1.2.3")).toBe(true);
  });

  it("blocks this-network (0.0.0.0/8)", () => {
    expect(ipIsPrivate("0.0.0.0")).toBe(true);
    expect(ipIsPrivate("0.1.2.3")).toBe(true);
  });

  it("blocks private 10.0.0.0/8", () => {
    expect(ipIsPrivate("10.0.0.1")).toBe(true);
    expect(ipIsPrivate("10.255.255.255")).toBe(true);
  });

  it("blocks private 172.16.0.0/12 (16-31 only)", () => {
    expect(ipIsPrivate("172.16.0.1")).toBe(true);
    expect(ipIsPrivate("172.31.255.255")).toBe(true);
    expect(ipIsPrivate("172.23.4.5")).toBe(true);
    // 172.15 and 172.32 are PUBLIC — must not be blocked.
    expect(ipIsPrivate("172.15.0.1")).toBe(false);
    expect(ipIsPrivate("172.32.0.1")).toBe(false);
  });

  it("blocks private 192.168.0.0/16", () => {
    expect(ipIsPrivate("192.168.0.1")).toBe(true);
    expect(ipIsPrivate("192.168.1.100")).toBe(true);
    // 192.169 is public.
    expect(ipIsPrivate("192.169.0.1")).toBe(false);
  });

  it("blocks link-local 169.254.0.0/16 incl. cloud metadata endpoint", () => {
    expect(ipIsPrivate("169.254.0.1")).toBe(true);
    expect(ipIsPrivate("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata
    expect(ipIsPrivate("169.254.255.255")).toBe(true);
    // 169.253 is public.
    expect(ipIsPrivate("169.253.0.1")).toBe(false);
  });

  it("blocks carrier-grade NAT 100.64.0.0/10 (64-127)", () => {
    expect(ipIsPrivate("100.64.0.1")).toBe(true);
    expect(ipIsPrivate("100.127.255.255")).toBe(true);
    expect(ipIsPrivate("100.100.100.100")).toBe(true);
    // 100.63 and 100.128 are public.
    expect(ipIsPrivate("100.63.0.1")).toBe(false);
    expect(ipIsPrivate("100.128.0.1")).toBe(false);
  });

  it("blocks multicast / reserved (224.0.0.0+)", () => {
    expect(ipIsPrivate("224.0.0.1")).toBe(true); // multicast
    expect(ipIsPrivate("239.255.255.255")).toBe(true); // multicast
    expect(ipIsPrivate("240.0.0.1")).toBe(true); // reserved
    expect(ipIsPrivate("255.255.255.255")).toBe(true); // broadcast
  });

  it("allows public addresses", () => {
    expect(ipIsPrivate("8.8.8.8")).toBe(false); // Google DNS
    expect(ipIsPrivate("1.1.1.1")).toBe(false); // Cloudflare DNS
    expect(ipIsPrivate("172.217.16.46")).toBe(false); // public (in 172 but outside /12)
  });
});

describe("ipIsPrivate — IPv6 reserved ranges", () => {
  it("blocks loopback ::1", () => {
    expect(ipIsPrivate("::1")).toBe(true);
  });

  it("blocks unspecified ::", () => {
    expect(ipIsPrivate("::")).toBe(true);
  });

  it("blocks link-local fe80::/10", () => {
    expect(ipIsPrivate("fe80::1")).toBe(true);
    expect(ipIsPrivate("fe80::a00:27ff:fe4e:66a1")).toBe(true);
  });

  it("blocks unique-local fc00::/7 (fc and fd prefixes)", () => {
    expect(ipIsPrivate("fc00::1")).toBe(true);
    expect(ipIsPrivate("fd12:3456:789a::1")).toBe(true);
  });

  it("handles IPv4-mapped ::ffff: addresses by delegating to IPv4 rules", () => {
    // Mapped private -> private
    expect(ipIsPrivate("::ffff:127.0.0.1")).toBe(true);
    expect(ipIsPrivate("::ffff:10.0.0.1")).toBe(true);
    expect(ipIsPrivate("::ffff:169.254.169.254")).toBe(true);
    // Mapped public -> public
    expect(ipIsPrivate("::ffff:8.8.8.8")).toBe(false);
    expect(ipIsPrivate("::ffff:1.1.1.1")).toBe(false);
  });

  it("allows public IPv6 addresses", () => {
    expect(ipIsPrivate("2606:4700:4700::1111")).toBe(false); // Cloudflare
    expect(ipIsPrivate("2001:4860:4860::8888")).toBe(false); // Google DNS
  });
});

describe("ipIsPrivate — malformed input is conservatively blocked", () => {
  // A malformed/unknown address must NEVER return false, or it could bypass the
  // SSRF check. The function returns true (block) for anything it can't classify.
  it("blocks non-numeric octets", () => {
    expect(ipIsPrivate("example.com")).toBe(true);
    expect(ipIsPrivate("foo.bar.baz.qux")).toBe(true);
    expect(ipIsPrivate("a.b.c.d")).toBe(true);
  });

  it("blocks octets out of range (high octet treated as reserved)", () => {
    // 999 in the first octet isn't a valid octet; with parseInt it becomes 999,
    // which is >= 224 so the multicast/reserved rule catches it -> blocked.
    expect(ipIsPrivate("999.1.1.1")).toBe(true);
    expect(ipIsPrivate("256.256.256.256")).toBe(true);
  });

  it("blocks wrong octet counts", () => {
    expect(ipIsPrivate("1.2.3")).toBe(true); // too few
    expect(ipIsPrivate("1.2.3.4.5")).toBe(true); // too many
    expect(ipIsPrivate("")).toBe(true);
    expect(ipIsPrivate("1.2.3.4.")).toBe(true); // trailing dot -> empty octet NaN
  });

  it("blocks incomplete numeric forms", () => {
    expect(ipIsPrivate("1..2.3")).toBe(true); // empty octet
    expect(ipIsPrivate(".1.2.3")).toBe(true);
  });
});
