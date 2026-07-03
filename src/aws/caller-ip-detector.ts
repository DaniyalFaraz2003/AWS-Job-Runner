const CHECKIP_URL = "https://checkip.amazonaws.com/";

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export class CallerIpDetector {
  /** Fetch the caller's public IPv4 for security group /32 rules (FR-LAUNCH-2). */
  async detectPublicIpv4(): Promise<string> {
    const response = await fetch(CHECKIP_URL, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to detect public IP (HTTP ${String(response.status)}).`,
      );
    }

    const ip = (await response.text()).trim();
    if (!IPV4_PATTERN.test(ip)) {
      throw new Error(`Detected value is not a valid IPv4 address: '${ip}'.`);
    }

    return ip;
  }
}

export function formatIpv4Cidr(ip: string): string {
  return `${ip}/32`;
}
