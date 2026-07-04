import { describe, expect, it } from "vitest";
import { ECTL_ERROR_CODES, EctlError } from "../../src/types/errors.js";
import {
  appendErrorHint,
  formatErrorMessage,
} from "../../src/types/error-hints.js";

describe("appendErrorHint", () => {
  it("appends a hint when the message has no action guidance", () => {
    const message = appendErrorHint(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      "Invalid config field: region",
    );
    expect(message).toBe("Invalid config field: region");
  });

  it("does not duplicate hints when message already includes Run ectl", () => {
    const original =
      "No .ectl/ directory found. Run `ectl init` in your project directory.";
    expect(
      appendErrorHint(ECTL_ERROR_CODES.NOT_INITIALIZED, original),
    ).toBe(original);
  });

  it("appends NO_ACTIVE_TASK hint for bare messages", () => {
    const message = appendErrorHint(
      ECTL_ERROR_CODES.NO_ACTIVE_TASK,
      "No active task.",
    );
    expect(message).toContain("Run `ectl deploy`");
  });
});

describe("formatErrorMessage", () => {
  it("formats EctlError with hints", () => {
    const error = new EctlError(
      ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
      "Timed out after 10 attempts.",
    );
    expect(formatErrorMessage(error)).toContain("Run `ectl status`");
  });

  it("passes through generic Error messages", () => {
    expect(formatErrorMessage(new Error("boom"))).toBe("boom");
  });
});
