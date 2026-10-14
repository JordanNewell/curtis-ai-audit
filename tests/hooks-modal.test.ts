import { describe, expect, it } from "vitest";
import { HooksManualModal } from "../src/hooks-modal";
import { HookTargetResult } from "../src/hooks-install";

const RESULTS: HookTargetResult[] = [
  { target: "codex", action: "manual", detail: "notify = [node, writer.mjs]" },
  { target: "gemini", action: "manual" },
];

describe("HooksManualModal", () => {
  it("titles the modal and builds one copyable row per manual target", () => {
    const modal = new HooksManualModal({} as never, RESULTS);
    modal.onOpen();
    expect((modal.titleEl as unknown as { text: string }).text).toBe(
      "Agent audit hooks — manual setup"
    );
    const rows = (modal.contentEl as unknown as { __settings: unknown[] }).__settings;
    expect(rows).toHaveLength(2);
  });

  it("shows the detail text and wires a Copy button per row", () => {
    const modal = new HooksManualModal({} as never, RESULTS);
    modal.onOpen();
    const rows = (modal.contentEl as unknown as { __settings: unknown[] }).__settings;
    const first = rows[0] as { descEl: { text: string }; buttonClick: ((b: unknown) => void) | null };
    expect(first.descEl.text).toBe("notify = [node, writer.mjs]");
    expect(typeof first.buttonClick).toBe("function");
    // missing-detail rows fall back to an empty description rather than "undefined"
    const second = rows[1] as { descEl: { text: string } };
    expect(second.descEl.text).toBe("");
  });

  it("copy falls back to a notice when no clipboard is available (node/test env)", () => {
    const modal = new HooksManualModal({} as never, RESULTS);
    modal.onOpen();
    const rows = (modal.contentEl as unknown as { __settings: unknown[] }).__settings;
    const first = rows[0] as { buttonClick: (b: unknown) => void };
    expect(() => first.buttonClick({})).not.toThrow();
  });
});
