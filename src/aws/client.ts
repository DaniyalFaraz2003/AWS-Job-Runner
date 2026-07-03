import { EC2Client } from "@aws-sdk/client-ec2";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface CreateEc2ClientOptions {
  readonly region: string;
  readonly maxAttempts?: number;
}

/** One EC2 client per command invocation (SRS §7.1, aws-sdk-v3 rule). */
export function createEc2Client(options: CreateEc2ClientOptions): EC2Client {
  return new EC2Client({
    region: options.region,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  });
}
