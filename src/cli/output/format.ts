import type { CliContext } from "../context.js";

export interface JsonEnvelope<T> {
  ok: boolean;
  command: string;
  data: T | null;
  error: {
    code: string;
    message: string;
  } | null;
}

export function printJson<T>(envelope: JsonEnvelope<T>): void {
  console.log(JSON.stringify(envelope));
}

export function printNotImplemented(ctx: CliContext, command: string): never {
  if (ctx.json) {
    printJson({
      ok: false,
      command,
      data: null,
      error: {
        code: "NOT_IMPLEMENTED",
        message: `${command} is not implemented yet`,
      },
    });
  } else {
    console.log(`ectl ${command} is not implemented yet`);
  }

  process.exit(1);
}
