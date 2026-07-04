import { describe, expect, it } from "vitest";
import {
  buildBasePackagesCheckCommand,
  buildBasePackagesInstallCommand,
  buildBootstrapCheckCommand,
  buildBootstrapInstallCommand,
  buildRuntimeCheckCommand,
  buildRuntimeInstallCommand,
  parseNodeMajorVersion,
} from "../../src/process/bootstrap-script.js";
import { EctlError } from "../../src/types/errors.js";

describe("parseNodeMajorVersion", () => {
  it("extracts major version from semver strings", () => {
    expect(parseNodeMajorVersion("22")).toBe("22");
    expect(parseNodeMajorVersion("22.15.0")).toBe("22");
    expect(parseNodeMajorVersion(" 20.11.1 ")).toBe("20");
  });

  it("throws for invalid nodeVersion values", () => {
    expect(() => parseNodeMajorVersion("")).toThrow(EctlError);
    expect(() => parseNodeMajorVersion("lts")).toThrow(EctlError);
  });
});

describe("buildBasePackagesCheckCommand", () => {
  it("checks curl and unzip only", () => {
    const command = buildBasePackagesCheckCommand();

    expect(command).toContain("command -v curl");
    expect(command).toContain("command -v unzip");
    expect(command).not.toContain("command -v pm2");
  });
});

describe("buildBasePackagesInstallCommand", () => {
  it("installs apt packages for transfer operations", () => {
    const command = buildBasePackagesInstallCommand();

    expect(command).toContain("sudo apt-get install -y -qq curl unzip");
    expect(command).not.toContain("deb.nodesource.com");
    expect(command).not.toContain("pm2");
  });
});

describe("buildRuntimeCheckCommand", () => {
  it("checks node, npm, pm2, and node major version", () => {
    const command = buildRuntimeCheckCommand("22");

    expect(command).toContain("command -v node");
    expect(command).toContain("command -v pm2");
    expect(command).toContain("grep -qx '22'");
    expect(command).not.toContain("command -v unzip");
  });
});

describe("buildRuntimeInstallCommand", () => {
  it("installs NodeSource node and pm2 without apt base packages", () => {
    const command = buildRuntimeInstallCommand("22");

    expect(command).toContain("https://deb.nodesource.com/setup_22.x");
    expect(command).toContain("sudo npm install -g pm2");
    expect(command).not.toContain("sudo apt-get install -y -qq curl unzip");
  });
});

describe("buildBootstrapCheckCommand", () => {
  it("checks base and runtime tools", () => {
    const command = buildBootstrapCheckCommand("22");

    expect(command).toContain("command -v curl");
    expect(command).toContain("command -v unzip");
    expect(command).toContain("command -v pm2");
    expect(command).toContain("grep -qx '22'");
  });
});

describe("buildBootstrapInstallCommand", () => {
  it("installs base and runtime tiers in one script", () => {
    const command = buildBootstrapInstallCommand("22");

    expect(command).toContain("sudo apt-get install -y -qq curl unzip");
    expect(command).toContain("https://deb.nodesource.com/setup_22.x");
    expect(command).toContain("sudo npm install -g pm2");
  });
});
