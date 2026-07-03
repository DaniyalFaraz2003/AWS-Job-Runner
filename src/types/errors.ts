/** SRS §10.1 error codes plus internal CLI codes. */
export const ECTL_ERROR_CODES = {
  NOT_INITIALIZED: "NOT_INITIALIZED",
  ACTIVE_TASK_EXISTS: "ACTIVE_TASK_EXISTS",
  NO_ACTIVE_TASK: "NO_ACTIVE_TASK",
  AWS_CREDENTIALS_INVALID: "AWS_CREDENTIALS_INVALID",
  INSTANCE_NO_PUBLIC_IP: "INSTANCE_NO_PUBLIC_IP",
  SSH_CONNECTION_FAILED: "SSH_CONNECTION_FAILED",
  RUN_COMMAND_MISSING: "RUN_COMMAND_MISSING",
  ARTIFACT_PATHS_EMPTY: "ARTIFACT_PATHS_EMPTY",
  DEPLOY_PARTIAL_FAILURE: "DEPLOY_PARTIAL_FAILURE",
  CONFIG_INVALID: "CONFIG_INVALID",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
} as const;

export type EctlErrorCode =
  (typeof ECTL_ERROR_CODES)[keyof typeof ECTL_ERROR_CODES];

export class EctlError extends Error {
  readonly code: EctlErrorCode;
  override readonly cause?: unknown;

  constructor(code: EctlErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "EctlError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isEctlError(error: unknown): error is EctlError {
  return error instanceof EctlError;
}

export function toEctlError(
  error: unknown,
  fallbackCode: EctlErrorCode = ECTL_ERROR_CODES.CONFIG_INVALID,
): EctlError {
  if (isEctlError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new EctlError(fallbackCode, message, error);
}
