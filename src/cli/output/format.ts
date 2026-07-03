import type { CliContext } from "../context.js";
import { ECTL_ERROR_CODES } from "../../types/errors.js";
import {
  createErrorEnvelope,
  printJson,
} from "./envelope.js";

export type { JsonEnvelope, JsonErrorPayload } from "./envelope.js";
export {
  createErrorEnvelope,
  createSuccessEnvelope,
  envelopeFromError,
  printErrorJson,
  printEctlErrorJson,
  printJson,
} from "./envelope.js";

export function printNotImplemented(ctx: CliContext, command: string): never {
  if (ctx.json) {
    printJson(
      createErrorEnvelope(
        command,
        ECTL_ERROR_CODES.NOT_IMPLEMENTED,
        `${command} is not implemented yet`,
      ),
    );
  } else {
    console.log(`ectl ${command} is not implemented yet`);
  }

  process.exit(1);
}
