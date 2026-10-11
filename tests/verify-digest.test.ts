import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { AuditLedger, shardHeader } from "../src/ledger";
import { verifyLedger } from "../src/verify";
import { buildDigest } from "../src/digest";
import { encodeBlock } from "../src/protocol";
import { AuditReceiptV1, buildReceipt } from "../src/schema";
import { FakeVault, fakeFileManager } from "./fake-vault";

const LEDGER_MARKER = "curtis-audit";

function makeReceipt(over: Partial<AuditReceiptV1>): AuditReceiptV1 {
  const receipt = buildReceipt(
    {
      agent: over.agent ?? "curtis-ai-chat",
      action: over.action ?? "inference",
      summary: over.summary,
      model: over.model,
      status: over.status,
    },
    { agent: over.agent ?? "curtis-ai-chat" }
  );
  return Object.assign(receipt, { seq: 0, recorded: new Date().toISOString() }, over);
}

function block(receipt: AuditReceiptV1): string {
  return encodeBlock(LEDGER_MARKER, receipt as unknown as Record<string, unknown>, "body");
}

async function ledgerWithFiles(files: Record<string, string>): Promise<AuditLedger> {
  const vault = new FakeVault(files);
  return new AuditLedger(vault as unknown as Vault, fakeFileManager(vault), "Audit");
}

describe("verifyLedger", () => {
  it("passes a clean ledger", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 1, recorded: `${day}T02:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.receipts).toBe(2);
    expect(report.agents[0]).toMatchObject({ agent: "curtis-ai-chat", count: 2, minSeq: 0, maxSeq: 1 });
  });

  it("reports sequence gaps as warnings", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 2, recorded: `${day}T02:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(true); // gaps are warnings, not errors
    expect(report.agents[0].missing).toEqual([1]);
    expect(report.issues.some((i) => i.message.includes("missing sequence number"))).toBe(true);
  });

  it("reports duplicate ids and seqs as errors", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const a = makeReceipt({ seq: 1, id: "rcp_dup", recorded: `${day}T01:00:00.000Z` });
    const b = makeReceipt({ seq: 1, id: "rcp_dup", recorded: `${day}T02:00:00.000Z` });
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]: shardHeader(day) + block(a) + block(b),
    });
    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(false);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(2);
  });

  it("reports malformed blocks", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })) +
        "<!-- curtis-audit: {broken",
    });
    const report = await verifyLedger(ledger);
    expect(report.malformed).toBe(1);
    expect(report.issues.some((i) => i.message.includes("malformed"))).toBe(true);
  });

  it("reports out-of-recorded-order edits within a shard", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 1, recorded: `${day}T02:00:00.000Z` })) +
        block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.issues.some((i) => i.message.includes("recorded-order"))).toBe(true);
  });
});

describe("buildDigest", () => {
  it("summarizes counts, statuses, tokens, errors, and latest receipts", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const okReceipt = makeReceipt({
      seq: 0,
      status: "ok",
      model: "gpt-4o",
      tokens: { input: 100, output: 40 },
      recorded: `${day}T01:00:00.000Z`,
    });
    const errReceipt = makeReceipt({
      seq: 1,
      status: "error",
      agent: "other-agent",
      summary: "provider 500",
      recorded: `${day}T02:00:00.000Z`,
    });
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]: shardHeader(day) + block(okReceipt) + block(errReceipt),
    });
    const digest = await buildDigest(ledger, { now: new Date() });
    expect(digest).toContain("**2** receipts — 1 ok, 1 error, 0 aborted");
    expect(digest).toContain("100 in / 40 out");
    expect(digest).toContain("| curtis-ai-chat | 1 | 1 | 0 | 0 | 100 | 40 |");
    expect(digest).toContain("| other-agent | 1 | 0 | 1 | 0 | — | — |");
    expect(digest).toContain("| inference | 2 |");
    expect(digest).toContain("provider 500");
    expect(digest).toContain("### Latest receipts");
    // single calendar day → no per-day breakdown
    expect(digest).not.toContain("### By day");
  });

  it("handles an empty period", async () => {
    const ledger = await ledgerWithFiles({});
    const digest = await buildDigest(ledger, { now: new Date() });
    expect(digest).toContain("No receipts in this period.");
  });

  it("adds a per-day table when the period spans multiple days", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const today = "2026-10-10";
    const yesterday = "2026-10-09";
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${today}.md`]:
        shardHeader(today) +
        block(makeReceipt({ seq: 0, recorded: `${today}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 1, status: "error", recorded: `${today}T02:00:00.000Z` })),
      [`Audit/ledger/${yesterday}.md`]:
        shardHeader(yesterday) + block(makeReceipt({ seq: 0, recorded: `${yesterday}T23:00:00.000Z` })),
    });
    const digest = await buildDigest(ledger, { days: 2, now });
    expect(digest).toContain("### By day");
    expect(digest).toContain(`| ${yesterday} | 1 | 1 | 0 | 0 |`);
    expect(digest).toContain(`| ${today} | 2 | 1 | 1 | 0 |`);
  });

  it("sums durations into the summary line", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, durationMs: 83000, recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 1, durationMs: 1200, recorded: `${day}T02:00:00.000Z` })),
    });
    const digest = await buildDigest(ledger, { now: new Date() });
    expect(digest).toContain("total duration 1m 24s");
  });
});
