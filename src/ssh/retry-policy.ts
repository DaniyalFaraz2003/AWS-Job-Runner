/** SRS NFR-3 / FR-LAUNCH-9: SSH retry with exponential backoff. */
export interface RetryPolicyOptions {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_SSH_RETRY_POLICY: RetryPolicyOptions = {
  maxAttempts: 10,
  initialDelayMs: 2_000,
  maxDelayMs: 30_000,
};

/** Delay after failure `attempt` (1-based). Doubles each time, capped at maxDelayMs. */
export function computeRetryDelayMs(
  attempt: number,
  policy: RetryPolicyOptions = DEFAULT_SSH_RETRY_POLICY,
): number {
  if (attempt < 1) {
    throw new RangeError("attempt must be >= 1");
  }

  const delay = policy.initialDelayMs * 2 ** (attempt - 1);
  return Math.min(delay, policy.maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
