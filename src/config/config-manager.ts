import { readFile, writeFile } from "node:fs/promises";
import { ZodError } from "zod";
import {
  ectlConfigSchema,
  type EctlConfig,
} from "../types/config.js";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";
import { getConfigPath } from "./paths.js";

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

export class ConfigManager {
  constructor(private readonly projectRoot: string) {}

  get configPath(): string {
    return getConfigPath(this.projectRoot);
  }

  async exists(): Promise<boolean> {
    try {
      await readFile(this.configPath, "utf8");
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  async read(): Promise<EctlConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        throw new EctlError(
          ECTL_ERROR_CODES.NOT_INITIALIZED,
          "Project config not found. Run `ectl init` first.",
          error,
        );
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        "Invalid JSON in .ectl/config.json.",
        error,
      );
    }

    const result = ectlConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        `Invalid .ectl/config.json: ${formatZodError(result.error)}`,
        result.error,
      );
    }

    return result.data;
  }

  async write(config: EctlConfig): Promise<void> {
    const result = ectlConfigSchema.safeParse(config);
    if (!result.success) {
      throw new EctlError(
        ECTL_ERROR_CODES.CONFIG_INVALID,
        `Cannot write invalid config: ${formatZodError(result.error)}`,
        result.error,
      );
    }

    const content = `${JSON.stringify(result.data, null, 2)}\n`;
    await writeFile(this.configPath, content, "utf8");
  }
}

export function createConfigManager(projectRoot: string): ConfigManager {
  return new ConfigManager(projectRoot);
}
