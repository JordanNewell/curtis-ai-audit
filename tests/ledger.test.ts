import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { AuditLedger, shardHeader } from "../src/ledger";
import { AuditReceiptV1, buildReceipt } from "../src/schema";
import { encodeBlock } from "../src/protocol";
import { FakeVault, fakeFileManager } from "./fake-vault";

const LEDGER_MARKER = "curtis-audit";

function makeLedger(vault: FakeVault): AuditLedger {
  return new AuditLedger(vault as unknown as Vault, fakeFileManager(vault), "Audit");
}

function makeReceipt(over: Partial<AuditReceiptV1> = {}): AuditReceiptV1 {
  const now = over.recorded ?? new Date().toISOString();
  const receipt = buildReceipt(
    { agent: "curtis-ai-chat", summary: over.summary ?? "", recorded: now },
    { agent: over.agent ?? "curtis-ai-chat" }
  );
  // seq stays at buildReceipt's placeholder (-1) unless the test claims one,
  // so tests exercise the ledger's seq guard
  return Object.assign(receipt, over);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Build, claim a seq for, and append a receipt in one step. */
async function appendNew(ledger: AuditLedger, over: Partial<AuditReceiptV1> = {}): Promise<AuditReceiptV1> {
  const receipt = makeReceipt(over);
  receipt.seq = await ledger.claimSeq(receipt.agent);
  await ledger.append(receipt);
  return receipt;
}

describe("AuditLedger.append", () => {
  it("creates the daily shard with a header and keeps append order", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();
    for (const summary of ["one", "two", "three"]) {
      const receipt = makeReceipt({ summary });
      receipt.seq = await ledger.claimSeq(receipt.agent);
      await ledger.append(receipt);
    }
    const path = ledger.shardPath(today());
    const content = vault.readRaw(path) ?? "";
    expect(content.startsWith(shardHeader(today()))).toBe(true);
    const read = await ledger.readShard(path);
    expect(read.receipts.map((r) => r.summary)).toEqual(["one", "two", "three"]);
    expect(read.receipts.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(read.malformed).toBe(0);
  });

  it("shards by recorded day", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const old = makeReceipt({ recorded: yesterday, summary: "old" });
    old.seq = await ledger.claimSeq(old.agent);
    await ledger.append(old);
    const recent = makeReceipt({ summary: "new" });
    recent.seq = await ledger.claimSeq(recent.agent);
    await ledger.append(recent);
    expect(ledger.listShards()).toHaveLength(2);
    expect((await ledger.readAll()).map((r) => r.summary)).toEqual(["old", "new"]);
  });

  it("keeps per-agent sequences independent", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    expect(await ledger.claimSeq("agent-a")).toBe(0);
    expect(await ledger.claimSeq("agent-b")).toBe(0);
    expect(await ledger.claimSeq("agent-a")).toBe(1);
  });

  it("refuses to append a receipt without a claimed seq", async () => {
    const ledger = makeLedger(new FakeVault());
    await expect(ledger.append(makeReceipt())).rejects.toThrow(/claimSeq/);
  });
});

describe("AuditLedger state", () => {
  it("persists seq state and a fresh instance continues where it left off", async () => {
    const vault = new FakeVault();
    const first = makeLedger(vault);
    await first.claimSeq("curtis-ai-chat");
    await first.claimSeq("curtis-ai-chat");
    await first.saveState();

    const second = makeLedger(vault);
    expect(await second.claimSeq("curtis-ai-chat")).toBe(2);
  });

  it("rebuilds seq state from the ledger when state.json is missing", async () => {
    const vault = new FakeVault();
    const day = today();
    const blocks =
      encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 4, recorded: `${day}T01:00:00.000Z` }), "a") +
      encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 9, recorded: `${day}T02:00:00.000Z` }), "b");
    vault.files.set(`Audit/ledger/${day}.md`, shardHeader(day) + blocks);

    const ledger = makeLedger(vault);
    expect(await ledger.claimSeq("curtis-ai-chat")).toBe(10);
    await ledger.saveState(); // the plugin always saves after a poll/record
    // state.json now exists for the next instance
    const second = makeLedger(vault);
    expect(await second.claimSeq("curtis-ai-chat")).toBe(11);
  });
});

describe("AuditLedger.readShard", () => {
  it("counts malformed blocks separately from valid receipts", async () => {
    const vault = new FakeVault();
    const day = today();
    const good = encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` }), "a");
    vault.files.set(`Audit/ledger/${day}.md`, shardHeader(day) + good + "garbage text\n");
    const ledger = makeLedger(vault);
    const read = await ledger.readShard(ledger.shardPath(day));
    expect(read.receipts).toHaveLength(1);
    expect(read.malformed).toBe(0);
  });

  it("counts truncated blocks as malformed", async () => {
    const vault = new FakeVault();
    const day = today();
    const good = encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 0, recorded: `${day}T01:00:00.000Z` }), "a");
    const truncated = "<!-- curtis-audit: {\"schema\":\"audit.v1\""; // never closed
    vault.files.set(`Audit/ledger/${day}.md`, shardHeader(day) + good + truncated + "\n");
    const ledger = makeLedger(vault);
    const read = await ledger.readShard(ledger.shardPath(day));
    expect(read.receipts).toHaveLength(1);
    expect(read.malformed).toBe(1);
  });
});

describe("AuditLedger.prune", () => {
  it("drops old receipts, keeps recent, deletes emptied shards", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();

    const now = Date.now();
    const oldDay = new Date(now - 10 * 86400000).toISOString().slice(0, 10);
    const recentDay = new Date(now - 86400000).toISOString().slice(0, 10);
    await appendNew(ledger, { recorded: `${oldDay}T12:00:00.000Z`, summary: "ancient" });
    await appendNew(ledger, { recorded: `${oldDay}T13:00:00.000Z`, summary: "also ancient" });
    await appendNew(ledger, { recorded: `${recentDay}T12:00:00.000Z`, summary: "yesterday" });
    await appendNew(ledger, { summary: "today" });

    const dropped = await ledger.prune(3);
    expect(dropped).toBe(2);

    const remaining = await ledger.readAll();
    expect(remaining.map((r) => r.summary).sort()).toEqual(["today", "yesterday"].sort());
    // the fully-emptied old shard is gone
    expect(ledger.listShards()).toHaveLength(2);
  });

  it("is a no-op when retention is off", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await appendNew(ledger, {});
    expect(await ledger.prune(0)).toBe(0);
    expect(await ledger.readAll()).toHaveLength(1);
  });
});
