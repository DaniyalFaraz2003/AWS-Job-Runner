import { describe, expect, it } from "vitest";
import { formatBytes } from "../../src/util/format-bytes.js";

describe("formatBytes", () => {
  it("formats bytes, kilobytes, megabytes, and gigabytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});
