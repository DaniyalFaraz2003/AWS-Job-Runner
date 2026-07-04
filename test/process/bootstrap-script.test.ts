import { describe, expect, it } from "vitest";
import {
  buildBootstrapCheckCommand,
  buildBootstrapInstallCommand,
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

describe("buildBootstrapCheckCommand", () => {
  it("checks required tools and node major version", () => {
    const command = buildBootstrapCheckCommand("22");

    expect(command).toContain("command -v curl");
    expect(command).toContain("command -v pm2");
    expect(command).toContain("grep -qx '22'");
  });
});

describe("buildBootstrapInstallCommand", () => {
  it("installs apt packages, NodeSource node, and pm2", () => {
    const command = buildBootstrapInstallCommand("22");

    expect(command).toContain("sudo apt-get install -y -qq curl unzip");
    expect(command).toContain("https://deb.nodesource.com/setup_22.x");
    expect(command).toContain("sudo npm install -g pm2");
  });
});
