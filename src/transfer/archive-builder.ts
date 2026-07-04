import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import archiver from "archiver";
import type { Ignore } from "ignore";
import { loadEctlignore } from "../config/ectlignore.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import type { TransferProgressHandlers } from "./progress.js";

export interface BuildArchiveOptions {
  readonly projectRoot: string;
  readonly ignore?: Ignore;
  readonly progress?: TransferProgressHandlers;
}

export interface BuildArchiveResult {
  readonly archivePath: string;
  readonly totalBytes: number;
  readonly cleanup: () => Promise<void>;
}

export class ArchiveBuilder {
  /** Build a zip archive honoring `.ectlignore` (FR-PUSH-1). */
  async build(options: BuildArchiveOptions): Promise<BuildArchiveResult> {
    const ig = options.ignore ?? (await loadEctlignore(options.projectRoot));
    const tempDir = await mkdtemp(join(tmpdir(), "ectl-archive-"));
    const archivePath = join(tempDir, "project.zip");

    options.progress?.onArchiveStart?.();

    const files = await collectIncludedFiles(options.projectRoot, ig);
    const totalBytes = await sumFileSizes(files);

    await writeZipArchive(
      archivePath,
      options.projectRoot,
      files,
      options.progress,
    );

    options.progress?.onArchiveComplete?.(totalBytes);

    return {
      archivePath,
      totalBytes,
      cleanup: async () => {
        await unlink(archivePath).catch(() => undefined);
      },
    };
  }
}

export function createArchiveBuilder(): ArchiveBuilder {
  return new ArchiveBuilder();
}

async function collectIncludedFiles(
  projectRoot: string,
  ig: Ignore,
): Promise<string[]> {
  const files: string[] = [];
  await walkDirectory(projectRoot, projectRoot, ig, files);
  return files;
}

async function walkDirectory(
  projectRoot: string,
  currentDir: string,
  ig: Ignore,
  files: string[],
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const relPath = toPosixPath(relative(projectRoot, absolutePath));

    if (entry.isDirectory()) {
      if (shouldIgnorePath(relPath, ig, true)) {
        continue;
      }
      await walkDirectory(projectRoot, absolutePath, ig, files);
      continue;
    }

    if (entry.isFile() && !shouldIgnorePath(relPath, ig, false)) {
      files.push(absolutePath);
    }
  }
}

function shouldIgnorePath(
  relPath: string,
  ig: Ignore,
  isDirectory: boolean,
): boolean {
  if (ig.ignores(relPath)) {
    return true;
  }

  if (isDirectory && ig.ignores(`${relPath}/`)) {
    return true;
  }

  return false;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function sumFileSizes(files: readonly string[]): Promise<number> {
  let total = 0;
  for (const filePath of files) {
    const info = await stat(filePath);
    total += info.size;
  }
  return total;
}

async function writeZipArchive(
  archivePath: string,
  projectRoot: string,
  files: readonly string[],
  progress?: TransferProgressHandlers,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("progress", (entry) => {
      progress?.onArchiveProgress?.(entry.fs.processedBytes);
    });

    archive.pipe(output);

    for (const absolutePath of files) {
      const relPath = toPosixPath(relative(projectRoot, absolutePath));
      archive.file(absolutePath, { name: relPath });
    }

    void archive.finalize().catch(reject);
  }).catch((error: unknown) => {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      `Failed to build project archive: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  });
}
