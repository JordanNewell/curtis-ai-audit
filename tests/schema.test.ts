import { describe, expect, it } from "vitest";
import {
  AuditReceiptV1,
  buildReceipt,
  normalizeAction,
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

  it("omits the provider when absent and pads missing token halves", () => {
    const noProvider = renderReceipt({ ...base, provider: undefined });
    expect(noProvider).toContain("`gpt-4o`");
    expect(noProvider).not.toContain(" via ");

    const halfTokens = renderReceipt({ ...base, tokens: { input: 100 } });
    expect(halfTokens).toContain("100 in / ? out");
  });

  it("renders a bare action and status when nothing else is set", () => {
    const minimal = buildReceipt({}, { agent: "curtis-ai-chat" });
    minimal.seq = 0;
    expect(renderReceipt(minimal)).toBe("**other** · ok");
  });
});

describe("validatePayload (edges)", () => {
  it("rejects a payload that cannot be JSON-serialized (circular detail)", () => {
    const circular: Record<string, unknown> = { agent: "curtis-ai-chat" };
    circular.self = circular;
    const result = validatePayload(circular);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/JSON-serializable/);
  });

  it("rejects non-object tokens", () => {
    expect(validatePayload({ ...validPayload, tokens: "100" as never }).ok).toBe(false);
  });

  it("rejects non-finite durationMs", () => {
    expect(validatePayload({ ...validPayload, durationMs: Number.POSITIVE_INFINITY }).ok).toBe(
      false
    );
  });

  it("accepts zero values and unknown extra keys", () => {
    expect(
      validatePayload({ ...validPayload, durationMs: 0, tokens: { input: 0, output: 0 }, extra: true })
    ).toEqual({ ok: true, errors: [] });
  });
});

describe("validateReceipt (edges)", () => {
  it("rejects fractional or negative seq", () => {
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
    expect(validateReceipt({ ...receipt, seq: 0.5 }).ok).toBe(false);
    expect(validateReceipt({ ...receipt, seq: -1 }).ok).toBe(false);
  });

  it("rejects an out-of-range seq beyond the safe integer range", () => {
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
    expect(validateReceipt({ ...receipt, seq: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    expect(validateReceipt({ ...receipt, seq: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
    expect(validateReceipt({ ...receipt, seq: 1e21 }).ok).toBe(false);
  });

  it("rejects a missing or unparsable recorded stamp", () => {
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
    expect(validateReceipt({ ...receipt, recorded: "nope" }).ok).toBe(false);
    const { recorded: _omitted, ...withoutRecorded } = receipt as Record<string, unknown>;
    expect(validateReceipt(withoutRecorded).ok).toBe(false);
  });

  it("rejects a non-object tokens field", () => {
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
    expect(validateReceipt({ ...receipt, tokens: [1, 2] }).ok).toBe(false);
  });

  it("does NOT validate token VALUES (unlike validatePayload — documented gap)", () => {
    // validatePayload rejects negative counts, but a hand-edited ledger block
    // carrying tokens: {input: -5} passes receipt validation
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
    expect(
      validateReceipt({ ...receipt, seq: 0, tokens: { input: -5, output: "many" } }).ok
    ).toBe(true);
  });

  it("rejects a missing action and an unknown status", () => {
    const receipt = buildReceipt(validPayload, { agent: "curtis-ai-chat" });
    const { action: _a, ...noAction } = receipt as Record<string, unknown>;
    expect(validateReceipt(noAction).ok).toBe(false);
    expect(validateReceipt({ ...receipt, status: "fine" }).ok).toBe(false);
  });
});

describe("normalizeAction", () => {
  it("trims, lowercases, and defaults empty to other", () => {
    expect(normalizeAction("  TOOL-Call ")).toBe("tool-call");
    expect(normalizeAction(undefined)).toBe("other");
    expect(normalizeAction("   ")).toBe("other");
  });
});

describe("buildReceipt (edges)", () => {
  it("normalizes date-only ts values to ISO", () => {
    const receipt = buildReceipt({ ts: "2026-10-10" }, { agent: "curtis-ai-chat" });
    expect(receipt.ts).toBe("2026-10-10T00:00:00.000Z");
  });

  it("falls back to status ok and drops unknown statuses", () => {
    expect(buildReceipt({ status: "meh" }, { agent: "curtis-ai-chat" }).status).toBe("ok");
    expect(buildReceipt({ status: "aborted" }, { agent: "curtis-ai-chat" }).status).toBe("aborted");
  });

  it("keeps an all-invalid tokens object off the receipt", () => {
    expect(
      buildReceipt({ tokens: { input: -1, output: -2 } as never }, { agent: "curtis-ai-chat" }).tokens
    ).toBeUndefined();
  });
});
