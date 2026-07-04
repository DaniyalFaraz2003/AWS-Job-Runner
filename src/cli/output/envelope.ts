import { formatErrorMessage } from "../../types/error-hints.js";
import {
  ECTL_ERROR_CODES,
  EctlError,
  isEctlError,
  type EctlErrorCode,
} from "../../types/errors.js";

export interface JsonErrorPayload {
  code: string;
  message: string;
}

export interface JsonEnvelope<T> {
  ok: boolean;
  command: string;
  data: T | null;
  error: JsonErrorPayload | null;
}

export function createSuccessEnvelope<T>(
  command: string,
  data: T,
): JsonEnvelope<T> {
  return {
    ok: true,
    command,
    data,
    error: null,
  };
}

export function createErrorEnvelope(
  command: string,
  code: EctlErrorCode | string,
  message: string,
): JsonEnvelope<null> {
  return {
    ok: false,
    command,
    data: null,
    error: { code, message },
  };
}

export function envelopeFromError(
  command: string,
  error: unknown,
): JsonEnvelope<null> {
  const message = formatErrorMessage(error);
  if (isEctlError(error)) {
    return createErrorEnvelope(command, error.code, message);
  }

  return createErrorEnvelope(command, ECTL_ERROR_CODES.CONFIG_INVALID, message);
}

export function printJson<T>(envelope: JsonEnvelope<T>): void {
  console.log(JSON.stringify(envelope));
}

export function printErrorJson(command: string, error: unknown): never {
  printJson(envelopeFromError(command, error));
  process.exit(1);
}

export function printEctlErrorJson(error: EctlError, command: string): never {
  printJson(createErrorEnvelope(command, error.code, error.message));
  process.exit(1);
}
