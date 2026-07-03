import { describe, expect, it } from "vitest";
import { SecurityGroupService } from "../../src/aws/security-group-service.js";

describe("SecurityGroupService", () => {
  it("builds the task security group name", () => {
    const service = new SecurityGroupService({} as never);
    expect(service.buildSecurityGroupName("my-app", "default")).toBe(
      "ectl-my-app-default",
    );
  });

  it("uses caller IP /32 when allowAnyIp is false", () => {
    const service = new SecurityGroupService({} as never);
    expect(
      service.resolveSshCidr({ allowAnyIp: false, callerIp: "198.51.100.1" }),
    ).toBe("198.51.100.1/32");
  });

  it("uses 0.0.0.0/0 when allowAnyIp is true", () => {
    const service = new SecurityGroupService({} as never);
    expect(service.resolveSshCidr({ allowAnyIp: true })).toBe("0.0.0.0/0");
  });
});
