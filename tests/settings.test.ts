import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/settings";

describe("sanitizeSettings", () => {
  it("returns full defaults for null, undefined, or an empty object", () => {
    for (const raw of [null, undefined, {}]) {
      expect(sanitizeSettings(raw as never)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("normalizes slashes in paths and trims the ends", () => {
    // NOTE (current behavior): trailing slashes are stripped before trim(), so
    // trailing whitespace protects a trailing slash from being removed
    expect(sanitizeSettings({ root: "  Audit//ledger\\\\ " }).root).toBe("Audit/ledger/");
    expect(sanitizeSettings({ messengerRoot: "C:\\\\Notes\\\\Bus" }).messengerRoot).toBe(
      "C:/Notes/Bus"
    );
    expect(sanitizeSettings({ root: "/leading/and/trailing/" }).root).toBe("leading/and/trailing");
    expect(sanitizeSettings({ root: "  Audit//ledger\\\\  " }).root).toBe("Audit/ledger/");
  });

  it("falls back to the default path when cleaning leaves nothing", () => {
    expect(sanitizeSettings({ root: "///" }).root).toBe(DEFAULT_SETTINGS.root);
    expect(sanitizeSettings({ root: "\\\\" }).root).toBe(DEFAULT_SETTINGS.root);
    expect(sanitizeSettings({ root: 42 as never }).root).toBe(DEFAULT_SETTINGS.root);
  });

  it("keeps a valid inbox address and rejects an invalid one", () => {
    expect(sanitizeSettings({ inboxAddress: "audit-box.v2" }).inboxAddress).toBe("audit-box.v2");
    expect(sanitizeSettings({ inboxAddress: "has space" }).inboxAddress).toBe("audit");
    expect(sanitizeSettings({ inboxAddress: "-starts-bad" }).inboxAddress).toBe("audit");
    expect(sanitizeSettings({ inboxAddress: "x".repeat(65) }).inboxAddress).toBe("audit");
    expect(sanitizeSettings({ inboxAddress: "x".repeat(64) }).inboxAddress).toBe("x".repeat(64));
    expect(sanitizeSettings({ inboxAddress: 7 as never }).inboxAddress).toBe("audit");
  });

  it("clamps pollSeconds into [1, 3600] and defaults garbage", () => {
    expect(sanitizeSettings({ pollSeconds: 0 }).pollSeconds).toBe(DEFAULT_SETTINGS.pollSeconds);
    // 0.5 is truthy so it skips the fallback, then floor(0.5)=0 clamps up to 1
    expect(sanitizeSettings({ pollSeconds: 0.5 }).pollSeconds).toBe(1);
    expect(sanitizeSettings({ pollSeconds: -100 }).pollSeconds).toBe(1);
    expect(sanitizeSettings({ pollSeconds: 99999 }).pollSeconds).toBe(3600);
    expect(sanitizeSettings({ pollSeconds: "45" as never }).pollSeconds).toBe(45);
    expect(sanitizeSettings({ pollSeconds: "soon" as never }).pollSeconds).toBe(10);
    expect(sanitizeSettings({ pollSeconds: undefined }).pollSeconds).toBe(10);
  });

  it("clamps retentionDays into [0, 36500] and floors fractions", () => {
    expect(sanitizeSettings({ retentionDays: -5 }).retentionDays).toBe(0);
    expect(sanitizeSettings({ retentionDays: 100.9 }).retentionDays).toBe(100);
    expect(sanitizeSettings({ retentionDays: 36501 }).retentionDays).toBe(36500);
    expect(sanitizeSettings({ retentionDays: "30" as never }).retentionDays).toBe(30);
    expect(sanitizeSettings({ retentionDays: "forever" as never }).retentionDays).toBe(0);
  });

  it("coerces debug to a boolean", () => {
    expect(sanitizeSettings({ debug: 1 as never }).debug).toBe(true);
    expect(sanitizeSettings({ debug: "yes" as never }).debug).toBe(true);
    expect(sanitizeSettings({ debug: 0 as never }).debug).toBe(false);
    expect(sanitizeSettings({ debug: undefined }).debug).toBe(false);
  });

  it("keeps object cursors, replaces null, and passes arrays through untouched (current behavior)", () => {
    const cursors = { "Messenger/audit/inbox.md": { id: "msg_1", ts: "t" } };
    expect(sanitizeSettings({ cursors }).cursors).toBe(cursors);
    expect(sanitizeSettings({ cursors: null as never }).cursors).toEqual({});
    // NOTE: arrays survive (typeof [] === "object"); documented here on purpose
    expect(sanitizeSettings({ cursors: [1, 2] as never }).cursors).toEqual([1, 2]);
  });
});
