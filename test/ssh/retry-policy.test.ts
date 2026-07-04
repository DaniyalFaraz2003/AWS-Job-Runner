import { describe, expect, it } from "vitest";
import {
  computeRetryDelayMs,
  DEFAULT_SSH_RETRY_POLICY,
} from "../../src/ssh/retry-policy.js";

describe("computeRetryDelayMs", () => {
  it("doubles delay each attempt up to the cap", () => {
    expect(computeRetryDelayMs(1)).toBe(2_000);
    expect(computeRetryDelayMs(2)).toBe(4_000);
    expect(computeRetryDelayMs(3)).toBe(8_000);
    expect(computeRetryDelayMs(4)).toBe(16_000);
    expect(computeRetryDelayMs(5)).toBe(30_000);
    expect(computeRetryDelayMs(6)).toBe(30_000);
  });

  it("respects custom policy limits", () => {
    const policy = {
      maxAttempts: 5,
      initialDelayMs: 1_000,
      maxDelayMs: 5_000,
    };

    expect(computeRetryDelayMs(1, policy)).toBe(1_000);
    expect(computeRetryDelayMs(2, policy)).toBe(2_000);
    expect(computeRetryDelayMs(3, policy)).toBe(4_000);
    expect(computeRetryDelayMs(4, policy)).toBe(5_000);
  });

  it("rejects non-positive attempts", () => {
    expect(() => computeRetryDelayMs(0)).toThrow(RangeError);
  });

  it("matches SRS default retry policy", () => {
    expect(DEFAULT_SSH_RETRY_POLICY.maxAttempts).toBe(10);
    expect(DEFAULT_SSH_RETRY_POLICY.initialDelayMs).toBe(2_000);
    expect(DEFAULT_SSH_RETRY_POLICY.maxDelayMs).toBe(30_000);
  });
});
