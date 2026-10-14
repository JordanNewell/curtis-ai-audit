import { describe, expect, it } from "vitest";
import { AuditReceiptV1, buildReceipt } from "../src/schema";
import { ReceiptQuery, queryReceipts } from "../src/query";

function makeReceipt(over: Partial<AuditReceiptV1>): AuditReceiptV1 {
  const receipt = buildReceipt(
    {
      agent: over.agent ?? "curtis-ai-chat",
      action: over.action ?? "inference",
      model: over.model,
      status: over.status,
      subject: over.subject,
      tokens: over.tokens,
    },
    { agent: over.agent ?? "curtis-ai-chat" }
  );
  return Object.assign(receipt, { seq: 0, recorded: new Date().toISOString() }, over);
}

const T0 = Date.parse("2026-10-10T10:00:00.000Z");

function at(minsAgo: number, over: Partial<AuditReceiptV1> = {}): AuditReceiptV1 {
  return makeReceipt({ recorded: new Date(T0 - minsAgo * 60000).toISOString(), ...over });
}

describe("queryReceipts", () => {
  const fixture = () => [
    at(30, { agent: "curtis-ai-chat", model: "gpt-4o" }),
    at(20, { agent: "research-agent", action: "tool-call" }),
    at(10, { agent: "curtis-ai-chat", status: "error" as const, summary: "500" }),
  ];

  it("returns everything newest-first by default", () => {
    const result = queryReceipts(fixture());
    expect(result.map((r) => r.agent)).toEqual(["curtis-ai-chat", "research-agent", "curtis-ai-chat"]);
  });

  it("orders oldest-first with order asc", () => {
    const result = queryReceipts(fixture(), { order: "asc" });
    expect(Date.parse(result[0].recorded)).toBeLessThan(Date.parse(result[1].recorded));
  });

  it("filters by agent, action, status, and model exactly", () => {
    expect(queryReceipts(fixture(), { agent: "curtis-ai-chat" })).toHaveLength(2);
    expect(queryReceipts(fixture(), { agent: "no-such-agent" })).toHaveLength(0);
    expect(queryReceipts(fixture(), { action: "tool-call" })).toHaveLength(1);
    expect(queryReceipts(fixture(), { status: "error" })).toHaveLength(1);
    expect(queryReceipts(fixture(), { model: "gpt-4o" })).toHaveLength(1);
  });

  it("matches a receipt without a model only when no model filter is given", () => {
    const receipts = [makeReceipt({})];
    expect(queryReceipts(receipts, {})).toHaveLength(1);
    expect(queryReceipts(receipts, { model: "gpt-4o" })).toHaveLength(0);
  });

  it("treats subject as a vault-path prefix", () => {
    const receipts = [
      makeReceipt({ subject: "Notes/deep/a.md" }),
      makeReceipt({ subject: "Notes2/b.md" }),
      makeReceipt({ subject: "Archive/Notes/c.md" }),
      makeReceipt({}),
    ];
    expect(queryReceipts(receipts, { subject: "Notes/" }).map((r) => r.subject)).toEqual([
      "Notes/deep/a.md",
    ]);
  });

  it("matches subject as a raw string prefix, not path-segment aware (documented)", () => {
    // a subject filter without a trailing slash also matches sibling folders
    const receipts = [makeReceipt({ subject: "Notes2/b.md" })];
    expect(queryReceipts(receipts, { subject: "Notes" }).map((r) => r.subject)).toEqual([
      "Notes2/b.md",
    ]);
  });

  it("applies inclusive since/until bounds on recorded", () => {
    const receipts = [at(30), at(20), at(10)];
    const since = new Date(T0 - 20 * 60000).toISOString();
    expect(queryReceipts(receipts, { since })).toHaveLength(2); // 20min and 10min ago
    expect(queryReceipts(receipts, { until: since })).toHaveLength(2); // 30min and the boundary
    expect(queryReceipts(receipts, { since, until: since })).toHaveLength(1); // the boundary itself
  });

  it("accepts epoch-ms bounds", () => {
    const receipts = [at(30), at(10)];
    expect(queryReceipts(receipts, { since: T0 - 15 * 60000 })).toHaveLength(1);
  });

  it("applies limit after ordering", () => {
    const result = queryReceipts(fixture(), { limit: 2 });
    expect(result).toHaveLength(2);
    expect(Date.parse(result[0].recorded)).toBeGreaterThan(Date.parse(result[1].recorded));
  });

  it("breaks recorded ties by seq (newest seq first when desc)", () => {
    const same = new Date(T0).toISOString();
    const receipts = [makeReceipt({ seq: 0, recorded: same }), makeReceipt({ seq: 1, recorded: same })];
    expect(queryReceipts(receipts, {}).map((r) => r.seq)).toEqual([1, 0]);
    expect(queryReceipts(receipts, { order: "asc" }).map((r) => r.seq)).toEqual([0, 1]);
  });

  it("throws on garbage bounds, order, limit, or status", () => {
    const receipts = fixture();
    expect(() => queryReceipts(receipts, { since: "not a date" })).toThrow(/since/);
    expect(() => queryReceipts(receipts, { until: Number.NaN })).toThrow(/until/);
    expect(() => queryReceipts(receipts, { order: "sideways" as unknown as "asc" })).toThrow(/order/);
    expect(() => queryReceipts(receipts, { limit: 0 })).toThrow(/limit/);
    expect(() => queryReceipts(receipts, { limit: 1.5 })).toThrow(/limit/);
    expect(() => queryReceipts(receipts, { status: "meh" as unknown as "ok" })).toThrow(/status/);
  });

  it("does not mutate the input array", () => {
    const receipts = fixture();
    const snapshot = receipts.map((r) => r.id);
    queryReceipts(receipts, {});
    expect(receipts.map((r) => r.id)).toEqual(snapshot);
  });

  it("returns nothing when the window is inverted", () => {
    const receipts = fixture();
    const t = new Date(T0 - 15 * 60000).toISOString();
    expect(queryReceipts(receipts, { since: t, until: new Date(T0 - 16 * 60000).toISOString() })).toEqual([]);
  });

  it("filters the aborted status too", () => {
    const receipts = [makeReceipt({ status: "aborted" }), makeReceipt({ status: "ok" })];
    expect(queryReceipts(receipts, { status: "aborted" })).toHaveLength(1);
  });

  it("handles empty input without complaint", () => {
    expect(queryReceipts([], { agent: "x" })).toEqual([]);
  });

  it("combines several filters conjunctively", () => {
    const receipts = [
      makeReceipt({ agent: "a", action: "inference", status: "error" }),
      makeReceipt({ agent: "a", action: "tool-call", status: "error" }),
      makeReceipt({ agent: "b", action: "inference", status: "error" }),
      makeReceipt({ agent: "a", action: "inference", status: "ok" }),
    ];
    expect(queryReceipts(receipts, { agent: "a", action: "inference", status: "error" })).toHaveLength(1);
  });
});
