/**
 * Baseline tests for src/util.ts pure helpers.
 * These pin current behavior so Phase 1's cache-token widening of
 * estimateCostUsd can't silently regress the 2-arg call path.
 */
import { describe, it, expect } from "vitest";
import { estimateCostUsd, isTransientError } from "../util.ts";

describe("estimateCostUsd", () => {
  it("charges the blended $3 input / $15 output per Mtok rate", () => {
    expect(estimateCostUsd(1_000_000, 0)).toBeCloseTo(3.0, 6);
    expect(estimateCostUsd(0, 1_000_000)).toBeCloseTo(15.0, 6);
  });

  it("scales linearly with token counts", () => {
    expect(estimateCostUsd(500_000, 0)).toBeCloseTo(1.5, 6);
    expect(estimateCostUsd(0, 500_000)).toBeCloseTo(7.5, 6);
  });

  it("is zero for zero tokens", () => {
    expect(estimateCostUsd(0, 0)).toBe(0);
  });

  it("combines input and output additively", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000)).toBeCloseTo(3.0 + 15.0, 6);
  });

  it("handles fractional Mtok correctly", () => {
    expect(estimateCostUsd(100_000, 50_000)).toBeCloseTo(0.3 + 0.75, 6);
  });

  it("charges cache-read tokens at ~10% of input rate ($0.30/Mtok)", () => {
    expect(estimateCostUsd(0, 0, 1_000_000, 0)).toBeCloseTo(0.3, 6);
    const inputCost = estimateCostUsd(1_000_000, 0);
    const cacheCost = estimateCostUsd(0, 0, 1_000_000, 0);
    expect(cacheCost).toBeLessThan(inputCost);
    expect(cacheCost).toBeCloseTo(inputCost * 0.1, 5);
  });

  it("charges cache-write tokens at ~125% of input rate ($3.75/Mtok)", () => {
    expect(estimateCostUsd(0, 0, 0, 1_000_000)).toBeCloseTo(3.75, 6);
    expect(estimateCostUsd(0, 0, 0, 1_000_000)).toBeGreaterThan(estimateCostUsd(1_000_000, 0));
  });

  it("combines all four token types additively", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBeCloseTo(3.0 + 15.0 + 0.3 + 3.75, 6);
  });
});

describe("isTransientError", () => {
  it("returns false for undefined/empty messages", () => {
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("")).toBe(false);
  });

  it("detects HTTP 5xx and 429 status codes", () => {
    expect(isTransientError("Request failed with status 429")).toBe(true);
    expect(isTransientError("500 Internal Server Error")).toBe(true);
    expect(isTransientError("got 502 Bad Gateway")).toBe(true);
    expect(isTransientError("503 Service Unavailable")).toBe(true);
    expect(isTransientError("HTTP 504")).toBe(true);
  });

  it("detects rate-limit / overload phrasing", () => {
    expect(isTransientError("rate limit exceeded")).toBe(true);
    expect(isTransientError("The model is overloaded")).toBe(true);
    expect(isTransientError("temporarily unavailable")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isTransientError("ECONNRESET")).toBe(true);
    expect(isTransientError("ETIMEDOUT")).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError("network error")).toBe(true);
    expect(isTransientError("request timed out")).toBe(true);
  });

  it("returns false for non-transient errors", () => {
    expect(isTransientError("Invalid API key")).toBe(false);
    expect(isTransientError("Model not found")).toBe(false);
    expect(isTransientError("400 Bad Request")).toBe(false);
  });
});
