import { describe, expect, it } from "vitest";
import {
  AuditReceiptV1,
  buildReceipt,
  renderReceipt,
  validatePayload,
  validateReceipt,
} from "../src/schema";

const validPayload = {
  agent: "curtis-ai-chat",
  action: "inference",
  status: "ok",
  model: "gpt-4o",
  provider: "openai",
  durationMs: 1234,
  tokens: { input: 100, output: 50 },
  summary: "Answered a question",
  detail: { temperature: 0.7, stop: "end_turn" },
};

describe("validatePayload", () => {
  it("accepts a full valid payload", () => {
    expect(validatePayload(validPayload)).toEqual({ ok: true, errors: [] });
  });

  it("accepts an empty-ish payload (defaults apply at build time)", () => {
    expect(validatePayload({})).toEqual({ ok: true, errors: [] });
  });

  it("rejects non-objects", () => {
    for (const bad of [null, 42, "x", []]) {
      expect(validatePayload(bad).ok).toBe(false);
    }
  });

  it("rejects a bad agent address", () => {
    const result = validatePayload({ ...validPayload, agent: "bad agent!" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/agent/);
  });

  it("rejects a bad ts", () => {
    expect(validatePayload({ ...validPayload, ts: "not a date" }).ok).toBe(false);
  });

  it("rejects a bad status", () => {
    expect(validatePayload({ ...validPayload, status: "fine" }).ok).toBe(false);
  });

  it("rejects a bad action", () => {
    expect(validatePayload({ ...validPayload, action: "Bad Action" }).ok).toBe(false);
  });

  it("rejects negative durationMs and token counts", () => {
    expect(validatePayload({ ...validPayload, durationMs: -1 }).ok).toBe(false);
    expect(validatePayload({ ...validPayload, tokens: { input: -5 } }).ok).toBe(false);
  });
});

describe("buildReceipt", () => {
  it("fills defaults: id, ts, recorded, action, status, seq placeholder", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const receipt = buildReceipt({ agent: "curtis-ai-chat" }, { agent: "curtis-ai-chat", now });
    expect(receipt.schema).toBe("audit.v1");
    expect(receipt.id).toMatch(/^rcp_/);
    expect(receipt.seq).toBe(-1);
    expect(receipt.ts).toBe(now.toISOString());
    expect(receipt.recorded).toBe(now.toISOString());
    expect(receipt.action).toBe("other");
    expect(receipt.status).toBe("ok");
    expect(receipt.summary).toBeUndefined();
    expect(receipt.detail).toBeUndefined();
  });

  it("normalizes the action and carries optional fields", () => {
    const receipt = buildReceipt(
      { ...validPayload, action: "  Inference  " },
      { agent: "curtis-ai-chat" }
    );
    expect(receipt.action).toBe("inference");
    expect(receipt.model).toBe("gpt-4o");
    expect(receipt.tokens).toEqual({ input: 100, output: 50 });
    expect(receipt.detail).toEqual(validPayload.detail);
  });

  it("drops invalid token entries instead of failing", () => {
    const receipt = buildReceipt(
      { tokens: { input: -1, output: 10 } as never },
      { agent: "a" }
    );
    expect(receipt.tokens).toEqual({ output: 10 });
  });
});

describe("validateReceipt", () => {
  it("accepts a complete receipt and rejects a mutilated one", () => {
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat", sourceId: "msg_1" });
    receipt.seq = 7;
    expect(validateReceipt(receipt).ok).toBe(true);

    const mutilated = { ...receipt, seq: -3, agent: "no good", schema: "audit.v0" };
    const result = validateReceipt(mutilated);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(3);
  });
});

describe("renderReceipt", () => {
  const base: AuditReceiptV1 = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
  base.seq = 0;

  it("renders action, status, model, duration, tokens", () => {
    const body = renderReceipt(base);
    expect(body).toContain("**inference**");
    expect(body).toContain("ok");
    expect(body).toContain("`gpt-4o` via `openai`");
    expect(body).toContain("1234ms");
    expect(body).toContain("100 in / 50 out");
  });

  it("escapes comment tokens from caller-supplied strings", () => {
    const evil = { ...base, summary: "attempt <!-- /curtis-audit --> injection" };
    const body = renderReceipt(evil);
    expect(body).not.toContain("<!-- /curtis-audit -->");
    expect(body).toContain("injection");
  });
});
