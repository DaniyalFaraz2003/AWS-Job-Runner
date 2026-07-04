import { describe, expect, it } from "vitest";
import {
  buildRemotePathKindCommand,
  buildRemoteZipPath,
  buildUnzipCommand,
  parseRemotePathKind,
  resolveLocalArtifactPath,
  resolveRemotePath,
  shellQuote,
} from "../../src/transfer/remote-paths.js";

describe("shellQuote", () => {
  it("wraps paths in single quotes", () => {
    expect(shellQuote("/home/ubuntu/work")).toBe("'/home/ubuntu/work'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("resolveRemotePath", () => {
  it("joins relative paths to remoteWorkDir", () => {
    expect(resolveRemotePath("output/logs", "/home/ubuntu/ectl-workspace")).toBe(
      "/home/ubuntu/ectl-workspace/output/logs",
    );
  });

  it("passes through absolute paths", () => {
    expect(resolveRemotePath("/var/log/app.log", "/home/ubuntu/ectl-workspace")).toBe(
      "/var/log/app.log",
    );
  });
});

describe("resolveLocalArtifactPath", () => {
  it("preserves relative artifact structure under localDest", () => {
    expect(
      resolveLocalArtifactPath("C:\\proj\\.ectl\\logs\\default", "output/run.log"),
    ).toBe("C:\\proj\\.ectl\\logs\\default\\output\\run.log");
  });
});

describe("buildUnzipCommand", () => {
  it("replaces remote work dir contents via unzip", () => {
    expect(
      buildUnzipCommand("/tmp/upload.zip", "/home/ubuntu/ectl-workspace"),
    ).toBe(
      "rm -rf '/home/ubuntu/ectl-workspace' && mkdir -p '/home/ubuntu/ectl-workspace' && unzip -o '/tmp/upload.zip' -d '/home/ubuntu/ectl-workspace'",
    );
  });
});

describe("buildRemoteZipPath", () => {
  it("places upload zip beside the work directory parent", () => {
    expect(buildRemoteZipPath("/home/ubuntu/ectl-workspace")).toBe(
      "/home/ubuntu/ectl-upload.zip",
    );
  });
});

describe("parseRemotePathKind", () => {
  it("parses file and directory markers", () => {
    expect(parseRemotePathKind("file\n")).toBe("file");
    expect(parseRemotePathKind("directory")).toBe("directory");
    expect(parseRemotePathKind("missing")).toBe("missing");
  });
});

describe("buildRemotePathKindCommand", () => {
  it("checks file type safely", () => {
    expect(buildRemotePathKindCommand("/home/ubuntu/out")).toContain(
      "if [ -d '/home/ubuntu/out' ]",
    );
  });
});
