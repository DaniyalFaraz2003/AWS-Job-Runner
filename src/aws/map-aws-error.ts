import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";

const CREDENTIAL_ERROR_NAMES = new Set([
  "UnauthorizedOperation",
  "AuthFailure",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "AccessDenied",
  "AccessDeniedException",
]);

export function isAwsCredentialError(error: unknown): boolean {
  if (error !== null && typeof error === "object" && "name" in error) {
    return CREDENTIAL_ERROR_NAMES.has(String((error as { name: string }).name));
  }
  return false;
}

export function wrapAwsError(error: unknown, message: string): EctlError {
  if (error instanceof EctlError) {
    return error;
  }

  if (isAwsCredentialError(error)) {
    return new EctlError(
      ECTL_ERROR_CODES.AWS_CREDENTIALS_INVALID,
      "AWS credentials are invalid or lack required permissions. Configure AWS credentials and try again.",
      error,
    );
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new EctlError(ECTL_ERROR_CODES.CONFIG_INVALID, `${message}: ${detail}`, error);
}
