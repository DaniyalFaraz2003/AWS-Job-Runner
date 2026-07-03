import { describe, expect, it } from "vitest";
import {
  DEFAULT_ECTLIGNORE_PATTERNS,
  createEctlignore,
  parseEctlignore,
} from "../../src/config/ectlignore.js";
import { taskRunSchema } from "../../src/types/run.js";
import { taskStateSchema } from "../../src/types/state.js";
import {
  createErrorEnvelope,
  createSuccessEnvelope,
  envelopeFromError,
} from "../../src/cli/output/envelope.js";
import { EctlError, ECTL_ERROR_CODES } from "../../src/types/errors.js";

describe("ectlignore", () => {
  it("exports default patterns from SRS", () => {
    expect(DEFAULT_ECTLIGNORE_PATTERNS).toContain("node_modules/");
    expect(DEFAULT_ECTLIGNORE_PATTERNS).toContain(".ectl/");
  });

  it("ignores paths matching default patterns", () => {
    const ig = createEctlignore();
    expect(ig.ignores("node_modules/pkg/index.js")).toBe(true);
    expect(ig.ignores("src/index.ts")).toBe(false);
  });

  it("parses custom ignore content", () => {
    const ig = parseEctlignore("*.log\n# comment\ntmp/");
    expect(ig.ignores("debug.log")).toBe(true);
    expect(ig.ignores("src/app.ts")).toBe(false);
  });
});

describe("taskStateSchema", () => {
  it("accepts valid task state", () => {
    const result = taskStateSchema.safeParse({
      taskName: "default",
      status: "running",
      instanceId: "i-123",
      publicIp: "1.2.3.4",
      securityGroupId: "sg-123",
      keyPairName: "ectl-key",
      region: "us-east-1",
      createdAt: "2026-07-03T12:00:00.000Z",
      updatedAt: "2026-07-03T12:05:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("taskRunSchema", () => {
  it("accepts valid run record", () => {
    const result = taskRunSchema.safeParse({
      command: "npm start",
      source: "flag",
      pm2ProcessName: "default",
      startedAt: "2026-07-03T12:00:00.000Z",
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
    });
    expect(result.success).toBe(true);
  });
});

describe("JSON envelope", () => {
  it("creates success envelope", () => {
    expect(createSuccessEnvelope("status", { ok: true })).toEqual({
      ok: true,
      command: "status",
      data: { ok: true },
      error: null,
    });
  });

  it("creates error envelope from EctlError", () => {
    const envelope = envelopeFromError(
      "init",
      new EctlError(ECTL_ERROR_CODES.NOT_INITIALIZED, "Run ectl init"),
    );
    expect(envelope).toEqual({
      ok: false,
      command: "init",
      data: null,
      error: {
        code: ECTL_ERROR_CODES.NOT_INITIALIZED,
        message: "Run ectl init",
      },
    });
  });

  it("createErrorEnvelope matches SRS shape", () => {
    expect(
      createErrorEnvelope("deploy", "ACTIVE_TASK_EXISTS", "terminate first"),
    ).toEqual({
      ok: false,
      command: "deploy",
      data: null,
      error: { code: "ACTIVE_TASK_EXISTS", message: "terminate first" },
    });
  });
});
