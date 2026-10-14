import { describe, expect, it } from "vitest";
import { NMOJI_DATA_URI } from "../src/nmoji";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("NMOJI_DATA_URI", () => {
  it("is a base64 PNG data URI", () => {
    expect(NMOJI_DATA_URI.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("decodes to a real PNG payload", () => {
    const bytes = Buffer.from(NMOJI_DATA_URI.split(",")[1], "base64");
    expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("contains no characters that would break an HTML attribute", () => {
    expect(NMOJI_DATA_URI).not.toMatch(/["'<>]/);
  });
});
