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

describe("verifyLedger (edge cases)", () => {
  it("passes an empty ledger with no shards", async () => {
    const report = await verifyLedger(await ledgerWithFiles({}));
    expect(report.ok).toBe(true);
    expect(report.shards).toBe(0);
    expect(report.receipts).toBe(0);
    expect(report.agents).toEqual([]);
    expect(report.issues).toEqual([]);
  });

  it("flags a receipt id duplicated across two shards", async () => {
    const day1 = "2026-10-09";
    const day2 = "2026-10-10";
    const shared = makeReceipt({ seq: 0, id: "rcp_shared", recorded: `${day1}T01:00:00.000Z` });
    const copy = makeReceipt({ seq: 1, id: "rcp_shared", recorded: `${day2}T01:00:00.000Z` });
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day1}.md`]: shardHeader(day1) + block(shared),
      [`Audit/ledger/${day2}.md`]: shardHeader(day2) + block(copy),
    });
    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.message.includes("rcp_shared appears 2 times"))).toBe(true);
  });

  it("does not flag equal seq numbers across different agents", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, agent: "agent-a", recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 0, agent: "agent-b", recorded: `${day}T02:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("truncates very long gap lists in the message but keeps the full array", async () => {
    const day = new Date().toISOString().slice(0, 10);
    // seqs 0 and 22..42 → 1..21 missing (21 gaps, MAX_LISTED is 20)
    let content = shardHeader(day) + block(makeReceipt({ seq: 0, recorded: `${day}T00:00:00.000Z` }));
    for (let seq = 22; seq <= 42; seq++) {
      content += block(makeReceipt({ seq, recorded: `${day}T00:00:01.000Z` }));
    }
    const ledger = await ledgerWithFiles({ [`Audit/ledger/${day}.md`]: content });
    const report = await verifyLedger(ledger);
    const agent = report.agents[0];
    expect(agent.missing).toHaveLength(21);
    const issue = report.issues.find((i) => i.message.includes("missing sequence number"));
    expect(issue?.message).toContain("21 missing sequence number(s)");
    expect(issue?.message).toContain("more)");
  });

  it("bounds gap enumeration: a huge seq range is counted arithmetically, not materialized", async () => {
    // seqs 0 and 9e15: a naive per-integer loop would hang or OOM; the count
    // is arithmetic and the list is only materialized for small ranges
    const day = "2026-10-10";
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 9_000_000_000_000_000, recorded: `${day}T02:00:00.000Z` })),
    });
    const start = Date.now();
    const report = await verifyLedger(ledger);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(report.agents[0]).toMatchObject({
      count: 2,
      minSeq: 0,
      maxSeq: 9_000_000_000_000_000,
    });
    expect(report.agents[0].missing).toHaveLength(0); // not materialized
    const issue = report.issues.find((i) => i.message.includes("missing sequence number"));
    expect(issue?.message).toContain("8999999999999999 missing sequence number(s)");
    expect(issue?.message).toContain("too large to list");
  });

  it("materializes the missing list when the gap range is small", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 3, recorded: `${day}T02:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.agents[0].missing).toEqual([1, 2]);
  });

  it("reports per-agent summaries sorted by address", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 2, agent: "zeta", recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 0, agent: "alpha", recorded: `${day}T02:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.agents.map((a) => a.agent)).toEqual(["alpha", "zeta"]);
    expect(report.agents[1]).toMatchObject({ count: 1, minSeq: 2, maxSeq: 2, missing: [] });
  });

  it("never reports a gap for seq numbers below an agent's minimum", async () => {
    // a shard whose earliest seq is 5 (history pruned) is not a gap
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]: shardHeader(day) + block(makeReceipt({ seq: 5, recorded: `${day}T01:00:00.000Z` })),
    });
    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });
});

describe("buildDigest (edge cases)", () => {
  it("excludes receipts recorded before the window", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const staleDay = "2026-10-07";
    const freshDay = "2026-10-10";
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${staleDay}.md`]:
        shardHeader(staleDay) + block(makeReceipt({ seq: 0, recorded: `${staleDay}T12:00:00.000Z` })),
      [`Audit/ledger/${freshDay}.md`]:
        shardHeader(freshDay) + block(makeReceipt({ seq: 0, recorded: `${freshDay}T09:00:00.000Z` })),
    });
    const digest = await buildDigest(ledger, { days: 1, now });
    expect(digest).toContain("**1** receipts");
    expect(digest).not.toContain(staleDay);
  });

  it("caps the error list at 10 while counting the total", async () => {
    const day = new Date().toISOString().slice(0, 10);
    let content = shardHeader(day);
    for (let seq = 0; seq < 12; seq++) {
      content += block(
        makeReceipt({
          seq,
          status: "error",
          summary: `failure ${seq}`,
          recorded: `${day}T${String(seq).padStart(2, "0")}:00:00.000Z`,
        })
      );
    }
    const ledger = await ledgerWithFiles({ [`Audit/ledger/${day}.md`]: content });
    const digest = await buildDigest(ledger, { now: new Date() });
    expect(digest).toContain("**12** receipts — 0 ok, 12 error, 0 aborted");
    expect(digest).toContain("### Errors (12 total, showing up to 10)");
    const listed = digest.match(/^- `rcp_[^`]+` \*\*curtis-ai-chat\*\* failure/gm) ?? [];
    expect(listed).toHaveLength(10);
  });

  it("counts aborted receipts and sorts the action table by frequency", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, status: "aborted", action: "inference", recorded: `${day}T01:00:00.000Z` })) +
        block(makeReceipt({ seq: 1, action: "tool-call", recorded: `${day}T02:00:00.000Z` })) +
        block(makeReceipt({ seq: 2, action: "tool-call", recorded: `${day}T03:00:00.000Z` })),
    });
    const digest = await buildDigest(ledger, { now: new Date() });
    // the aborted receipt + the two default-ok tool-calls
    expect(digest).toContain("**3** receipts — 2 ok, 0 error, 1 aborted");
    expect(digest.indexOf("| tool-call | 2 |")).toBeLessThan(digest.indexOf("| inference | 1 |"));
  });

  it("formats sub-second and multi-hour durations", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) +
        block(makeReceipt({ seq: 0, durationMs: 740, recorded: `${day}T01:00:00.000Z` })),
    });
    const digest = await buildDigest(ledger, { now: new Date() });
    expect(digest).toContain("total duration 740ms");

    const bigDay = "2026-10-10";
    const big = await ledgerWithFiles({
      [`Audit/ledger/${bigDay}.md`]:
        shardHeader(bigDay) +
        block(makeReceipt({ seq: 0, durationMs: 3_700_000, recorded: `${bigDay}T01:00:00.000Z` })),
    });
    const bigDigest = await buildDigest(big, { now: new Date(bigDay + "T12:00:00.000Z") });
    expect(bigDigest).toContain("total duration 1h 1m");
  });

  it("omits the token part of the summary when no receipt carries tokens", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ledger = await ledgerWithFiles({
      [`Audit/ledger/${day}.md`]:
        shardHeader(day) + block(makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` })),
    });
    const digest = await buildDigest(ledger, { now: new Date() });
    expect(digest).toMatch(/\*\*1\*\* receipts — 1 ok, 0 error, 0 aborted\./);
    expect(digest).not.toContain("in /");
  });
});
