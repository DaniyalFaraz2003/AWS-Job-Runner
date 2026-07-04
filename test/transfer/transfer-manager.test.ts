import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildArchiveResult } from "../../src/transfer/archive-builder.js";
import { TransferManager } from "../../src/transfer/transfer-manager.js";
import { ECTL_ERROR_CODES } from "../../src/types/errors.js";
import type {
  ExecCommandResult,
  GetFileOptions,
  PutFileOptions,
} from "../../src/ssh/node-ssh-client.js";
import type { SshManager } from "../../src/ssh/ssh-manager.js";

class MockArchiveBuilder {
  build = vi.fn(async (): Promise<BuildArchiveResult> => ({
    archivePath: "C:\\Temp\\project.zip",
    totalBytes: 1024,
    cleanup: vi.fn(async () => undefined),
  }));
}

function createMockSsh(): SshManager {
  return {
    putFile: vi.fn(async (_local: string, _remote: string, _opts?: PutFileOptions) =>
      undefined,
    ),
    execCommand: vi.fn(async (command: string): Promise<ExecCommandResult> => {
      if (command.includes("if [ -d")) {
        return { stdout: "file", stderr: "", code: 0, signal: null };
      }
      if (command.includes("unzip")) {
        return { stdout: "", stderr: "", code: 0, signal: null };
      }
      return { stdout: "", stderr: "", code: 0, signal: null };
    }),
    getFile: vi.fn(async (_remote: string, _local: string, _opts?: GetFileOptions) =>
      undefined,
    ),
    getDirectory: vi.fn(
      async (_remote: string, _local: string, _opts?: GetFileOptions) =>
        undefined,
    ),
  } as unknown as SshManager;
}

describe("TransferManager.pushProject", () => {
  let ssh: SshManager;
  let archiveBuilder: MockArchiveBuilder;
  let manager: TransferManager;

  beforeEach(() => {
    ssh = createMockSsh();
    archiveBuilder = new MockArchiveBuilder();
    manager = new TransferManager({ ssh, archiveBuilder });
  });

  it("builds archive, uploads, unzips, and cleans up temp file", async () => {
    const progress = {
      onUploadStart: vi.fn(),
      onUploadComplete: vi.fn(),
      onUnzipStart: vi.fn(),
      onUnzipComplete: vi.fn(),
    };

    await manager.pushProject({
      projectRoot: "C:\\proj",
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
      progress,
    });

    expect(archiveBuilder.build).toHaveBeenCalledOnce();
    expect(ssh.putFile).toHaveBeenCalledWith(
      "C:\\Temp\\project.zip",
      "/home/ubuntu/ectl-upload.zip",
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );

    const execCalls = vi.mocked(ssh.execCommand).mock.calls.map(([cmd]) => cmd);
    expect(execCalls.some((cmd) => cmd.includes("unzip"))).toBe(true);
    expect(execCalls.some((cmd) => cmd.includes("rm -f"))).toBe(true);

    expect(progress.onUploadStart).toHaveBeenCalledWith(1024);
    expect(progress.onUploadComplete).toHaveBeenCalled();
    expect(progress.onUnzipStart).toHaveBeenCalled();
    expect(progress.onUnzipComplete).toHaveBeenCalled();
  });

  it("cleans up archive even when upload fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    archiveBuilder.build.mockResolvedValue({
      archivePath: "C:\\Temp\\project.zip",
      totalBytes: 512,
      cleanup,
    });
    vi.mocked(ssh.putFile).mockRejectedValue(new Error("upload failed"));

    await expect(
      manager.pushProject({
        projectRoot: "C:\\proj",
        remoteWorkDir: "/home/ubuntu/ectl-workspace",
      }),
    ).rejects.toThrow("upload failed");

    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("TransferManager.pullArtifacts", () => {
  let ssh: SshManager;
  let manager: TransferManager;

  beforeEach(() => {
    ssh = createMockSsh();
    manager = new TransferManager({ ssh });
  });

  it("rejects empty artifact path lists", async () => {
    await expect(
      manager.pullArtifacts({
        paths: [],
        remoteWorkDir: "/home/ubuntu/ectl-workspace",
        localDest: "C:\\proj\\.ectl\\logs\\default",
      }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.ARTIFACT_PATHS_EMPTY,
    });
  });

  it("downloads files preserving local structure", async () => {
    const progress = {
      onPullStart: vi.fn(),
      onPullComplete: vi.fn(),
    };

    const pulled = await manager.pullArtifacts({
      paths: ["output/result.json"],
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
      localDest: "C:\\proj\\.ectl\\logs\\default",
      progress,
    });

    expect(pulled).toEqual([
      {
        artifactPath: "output/result.json",
        localPath: "C:\\proj\\.ectl\\logs\\default\\output\\result.json",
        kind: "file",
      },
    ]);
    expect(ssh.getFile).toHaveBeenCalledWith(
      "/home/ubuntu/ectl-workspace/output/result.json",
      "C:\\proj\\.ectl\\logs\\default\\output\\result.json",
    );
    expect(progress.onPullStart).toHaveBeenCalledWith("output/result.json");
    expect(progress.onPullComplete).toHaveBeenCalled();
  });

  it("downloads directories with getDirectory", async () => {
    vi.mocked(ssh.execCommand).mockResolvedValue({
      stdout: "directory",
      stderr: "",
      code: 0,
      signal: null,
    });

    const pulled = await manager.pullArtifacts({
      paths: ["output/"],
      remoteWorkDir: "/home/ubuntu/ectl-workspace",
      localDest: "C:\\proj\\.ectl\\logs\\default",
    });

    expect(pulled[0]?.kind).toBe("directory");
    expect(ssh.getDirectory).toHaveBeenCalledWith(
      "/home/ubuntu/ectl-workspace/output/",
      "C:\\proj\\.ectl\\logs\\default\\output",
    );
  });

  it("fails when remote artifact is missing", async () => {
    vi.mocked(ssh.execCommand).mockResolvedValue({
      stdout: "missing",
      stderr: "",
      code: 0,
      signal: null,
    });

    await expect(
      manager.pullArtifacts({
        paths: ["missing.txt"],
        remoteWorkDir: "/home/ubuntu/ectl-workspace",
        localDest: "C:\\proj\\.ectl\\logs\\default",
      }),
    ).rejects.toMatchObject({
      code: ECTL_ERROR_CODES.SSH_CONNECTION_FAILED,
    });
  });
});
