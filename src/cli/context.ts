export interface CliContext {
  readonly json: boolean;
  readonly verbose: boolean;
}

export function createCliContext(options: {
  json?: boolean;
  verbose?: boolean;
}): CliContext {
  return {
    json: options.json ?? false,
    verbose: options.verbose ?? false,
  };
}

export function logVerbose(ctx: CliContext, message: string): void {
  if (ctx.verbose) {
    console.error(`[verbose] ${message}`);
  }
}

export function awsProvisionerDeps(
  ctx: CliContext,
): { onVerbose: (message: string) => void } | Record<string, never> {
  if (!ctx.verbose) {
    return {};
  }

  return {
    onVerbose: (message: string) => logVerbose(ctx, message),
  };
}
