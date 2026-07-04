import { ECTL_ERROR_CODES, isEctlError, type EctlErrorCode } from "./errors.js";

/** Suggested next steps keyed by SRS §10.1 error codes (NFR-4). */
const ERROR_HINTS: Readonly<Record<EctlErrorCode, string | null>> = {
  [ECTL_ERROR_CODES.NOT_INITIALIZED]:
    "Run `ectl init` in your project directory.",
  [ECTL_ERROR_CODES.ACTIVE_TASK_EXISTS]:
    "Run `ectl terminate` to clean up the existing task.",
  [ECTL_ERROR_CODES.NO_ACTIVE_TASK]:
    "Run `ectl deploy` or `ectl launch` to start a task.",
  [ECTL_ERROR_CODES.AWS_CREDENTIALS_INVALID]:
    "Configure AWS credentials (e.g. `aws configure` or set AWS_PROFILE).",
  [ECTL_ERROR_CODES.INSTANCE_NO_PUBLIC_IP]:
    "Check that your default VPC subnet has auto-assign public IP enabled.",
  [ECTL_ERROR_CODES.SSH_CONNECTION_FAILED]:
    "Run `ectl status` to verify the instance IP and security group.",
  [ECTL_ERROR_CODES.RUN_COMMAND_MISSING]:
    'Pass `--run "<cmd>"` or create `.ectl/run.sh` in your project.',
  [ECTL_ERROR_CODES.ARTIFACT_PATHS_EMPTY]:
    "Add `artifactPaths` to `.ectl/config.json` or pass `--paths`.",
  [ECTL_ERROR_CODES.DEPLOY_PARTIAL_FAILURE]:
    "Run `ectl status`, `ectl ssh`, or `ectl terminate` as needed.",
  [ECTL_ERROR_CODES.CONFIG_INVALID]: null,
  [ECTL_ERROR_CODES.STATE_INVALID]:
    "Run `ectl status` to reconcile local state with AWS.",
  [ECTL_ERROR_CODES.NOT_IMPLEMENTED]: null,
};

const HAS_ACTION_HINT = /Run `?ectl|Recovery:|Next:/i;

/** Append a next-step hint when the message does not already include one. */
export function appendErrorHint(code: EctlErrorCode, message: string): string {
  if (HAS_ACTION_HINT.test(message)) {
    return message;
  }

  const hint = ERROR_HINTS[code];
  if (hint === null || hint === undefined) {
    return message;
  }

  return `${message} ${hint}`;
}

/** Format any thrown value for human or JSON error output. */
export function formatErrorMessage(error: unknown): string {
  if (isEctlError(error)) {
    return appendErrorHint(error.code, error.message);
  }

  return error instanceof Error ? error.message : String(error);
}
