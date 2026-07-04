import { EC2Client } from "@aws-sdk/client-ec2";

const DEFAULT_MAX_ATTEMPTS = 3;

export interface CreateEc2ClientOptions {
  readonly region: string;
  readonly maxAttempts?: number;
  readonly onVerbose?: (message: string) => void;
}

interface AwsResponseMetadata {
  readonly requestId?: string;
  readonly httpStatusCode?: number;
}

function wrapSendWithVerboseLogging(
  client: EC2Client,
  onVerbose: (message: string) => void,
): EC2Client {
  const originalSend = client.send.bind(client);

  (client as { send: typeof client.send }).send = (async (
    command: Parameters<typeof client.send>[0],
    options?: Parameters<typeof client.send>[1],
  ) => {
    const result = await originalSend(command, options);
    const metadata = (result as unknown as { $metadata?: AwsResponseMetadata })
      .$metadata;
    if (metadata?.requestId !== undefined) {
      const commandName =
        (command as { constructor?: { name?: string } }).constructor?.name ??
        "EC2Command";
      const status = metadata.httpStatusCode ?? "?";
      onVerbose(
        `AWS ${commandName} → HTTP ${status} (requestId=${metadata.requestId})`,
      );
    }
    return result;
  }) as typeof client.send;

  return client;
}

/** One EC2 client per command invocation (SRS §7.1, aws-sdk-v3 rule). */
export function createEc2Client(options: CreateEc2ClientOptions): EC2Client {
  const client = new EC2Client({
    region: options.region,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  });

  if (options.onVerbose !== undefined) {
    return wrapSendWithVerboseLogging(client, options.onVerbose);
  }

  return client;
}
