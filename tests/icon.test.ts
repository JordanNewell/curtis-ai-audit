import { describe, expect, it } from "vitest";
import { CURTIS_MARK_ICON_ID, CURTIS_MARK_SVG } from "../src/icon";

describe("CURTIS_MARK_SVG", () => {
  it("is a complete svg document with the expected viewBox", () => {
    expect(CURTIS_MARK_SVG.startsWith('<svg viewBox="0 0 1024 1024"')).toBe(true);
    expect(CURTIS_MARK_SVG.endsWith("</svg>")).toBe(true);
  });

  it("pins the brand green rather than currentColor", () => {
    expect(CURTIS_MARK_SVG).toContain("#0E7A45");
    expect(CURTIS_MARK_SVG).not.toContain("currentColor");
  });

  it("draws the C ring and the check stroke", () => {
    expect(CURTIS_MARK_SVG).toContain("<path");
    expect(CURTIS_MARK_SVG).toContain('stroke-linecap="round"');
    expect(CURTIS_MARK_SVG).toContain('stroke-width="58"');
  });
});

describe("CURTIS_MARK_ICON_ID", () => {
  it("is the registration id main.ts hands to addIcon", () => {
    expect(CURTIS_MARK_ICON_ID).toBe("curtis-ai-mark");
  });
});
