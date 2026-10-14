import { describe, expect, it } from "vitest";
import { Vault, normalizePath } from "obsidian";
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

  it("rewrites partially-kept shards with the header intact", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();
    // A shard straddles the cutoff only when the cutoff falls inside its day:
    // prune's cutoff is now - maxAgeDays, so seed two receipts minutes apart
    // around a 5-minute retention window (cutoff comparisons are time-of-day
    // based, so this is deterministic regardless of when the test runs).
    const day = today();
    const dropped = makeReceipt({
      recorded: new Date(Date.now() - 8 * 60000).toISOString(),
      summary: "drop me",
    });
    dropped.seq = 0;
    const kept = makeReceipt({
      recorded: new Date(Date.now() - 2 * 60000).toISOString(),
      summary: "keep me",
    });
    kept.seq = 1;
    vault.files.set(
      ledger.shardPath(day),
      shardHeader(day) +
        encodeBlock(LEDGER_MARKER, dropped as unknown as Record<string, unknown>, "d") +
        encodeBlock(LEDGER_MARKER, kept as unknown as Record<string, unknown>, "k")
    );

    expect(await ledger.prune(5 / 1440)).toBe(1); // retention = 5 minutes, in days
    const path = ledger.shardPath(day);
    expect(vault.readRaw(path)?.startsWith(shardHeader(day))).toBe(true);
    const read = await ledger.readShard(path);
    expect(read.receipts.map((r) => r.summary)).toEqual(["keep me"]);
    expect(read.receipts[0].seq).toBe(1);
  });

  it("leaves non-ledger content in the ledger folder alone", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    const day = today();
    vault.files.set(`Audit/ledger/${day}.md`, "# Just prose\n\nNothing audit-shaped.\n");
    expect(await ledger.prune(1)).toBe(0);
    expect(vault.readRaw(`Audit/ledger/${day}.md`)).toContain("Just prose");
  });
});

describe("AuditLedger.append (guards)", () => {
  it("rejects negative and fractional seqs, not just the -1 placeholder", async () => {
    const ledger = makeLedger(new FakeVault());
    await expect(ledger.append(makeReceipt({ seq: -3 }))).rejects.toThrow(/seq/);
    await expect(ledger.append(makeReceipt({ seq: 1.5 }))).rejects.toThrow(/seq/);
  });

  it("appends to an existing shard through the atomic process path", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();
    await appendNew(ledger, { summary: "first" });
    await appendNew(ledger, { summary: "second" });
    expect(vault.processCalls).toBeGreaterThan(0);
    const read = await ledger.readShard(ledger.shardPath(today()));
    expect(read.receipts.map((r) => r.summary)).toEqual(["first", "second"]);
  });

  it("recovers when shard creation races another writer", async () => {
    const day = today();
    class RacyVault extends FakeVault {
      async create(path: string, _data: string): Promise<void> {
        if (!this.files.has(normalizePath(path))) {
          // the other writer wins the create, writing its own header first
          await super.create(path, shardHeader(day));
        }
        throw new Error(`File already exists: ${path}`);
      }
    }
    const vault = new RacyVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();
    const receipt = makeReceipt({ summary: "raced" });
    receipt.seq = await ledger.claimSeq(receipt.agent);
    await ledger.append(receipt);
    const path = ledger.shardPath(today());
    expect(vault.readRaw(path)?.startsWith(shardHeader(today()))).toBe(true);
    expect((await ledger.readShard(path)).receipts).toHaveLength(1);
  });
});

describe("AuditLedger listing and reads", () => {
  it("lists only date-named shards, sorted oldest first", async () => {
    const vault = new FakeVault();
    vault.files.set("Audit/ledger/2026-10-02.md", "b");
    vault.files.set("Audit/ledger/2026-10-01.md", "a");
    vault.files.set("Audit/ledger/notes.md", "not a shard");
    vault.files.set("Audit/other.md", "not in the dir");
    const ledger = makeLedger(vault);
    expect(ledger.listShards()).toEqual(["Audit/ledger/2026-10-01.md", "Audit/ledger/2026-10-02.md"]);
  });

  it("readShard on a missing file returns an empty read", async () => {
    const ledger = makeLedger(new FakeVault());
    expect(await ledger.readShard("Audit/ledger/2026-01-01.md")).toEqual({
      receipts: [],
      blocks: 0,
      malformed: 0,
    });
  });

  it("readAll walks shards oldest first", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.ensureDirs();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await appendNew(ledger, { recorded: `${yesterday}T12:00:00.000Z`, summary: "old" });
    await appendNew(ledger, { summary: "new" });
    expect((await ledger.readAll()).map((r) => r.summary)).toEqual(["old", "new"]);
  });
});

describe("AuditLedger state (edge cases)", () => {
  it("rebuilds from shards when state.json is corrupt", async () => {
    const vault = new FakeVault();
    const day = today();
    vault.files.set(
      `Audit/ledger/${day}.md`,
      shardHeader(day) +
        encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 5, recorded: `${day}T01:00:00.000Z` }), "a")
    );
    vault.files.set("Audit/state.json", "{not json at all");
    const ledger = makeLedger(vault);
    expect(await ledger.claimSeq("curtis-ai-chat")).toBe(6);
  });

  it("rebuilds when state.json has the wrong shape", async () => {
    const vault = new FakeVault();
    const day = today();
    vault.files.set(
      `Audit/ledger/${day}.md`,
      shardHeader(day) +
        encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 2, recorded: `${day}T01:00:00.000Z` }), "a")
    );
    vault.files.set("Audit/state.json", '{"version":1,"agents":"nonsense"}');
    const ledger = makeLedger(vault);
    expect(await ledger.claimSeq("curtis-ai-chat")).toBe(3);
  });

  it("ignores garbage entries inside an otherwise valid state file", async () => {
    const vault = new FakeVault();
    vault.files.set(
      "Audit/state.json",
      '{"version":1,"agents":{"good":{"lastSeq":4},"bad":{"lastSeq":-2},"worse":{"lastSeq":1.5}},"updated":"t"}'
    );
    const ledger = makeLedger(vault);
    expect(await ledger.claimSeq("good")).toBe(5);
    // invalid entries were dropped, so those agents start from scratch
    expect(await ledger.claimSeq("bad")).toBe(0);
    expect(await ledger.claimSeq("worse")).toBe(0);
  });

  it("saveState writes nothing until a seq has been claimed", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.saveState();
    expect(vault.readRaw("Audit/state.json")).toBeUndefined();
  });

  it("rebuildState recomputes high-water marks for every agent", async () => {
    const vault = new FakeVault();
    const day = today();
    vault.files.set(
      `Audit/ledger/${day}.md`,
      shardHeader(day) +
        encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 0, agent: "agent-a", recorded: `${day}T01:00:00.000Z` }), "a") +
        encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 3, agent: "agent-a", recorded: `${day}T02:00:00.000Z` }), "b") +
        encodeBlock(LEDGER_MARKER, makeReceipt({ seq: 7, agent: "agent-b", recorded: `${day}T03:00:00.000Z` }), "c")
    );
    const ledger = makeLedger(vault);
    await ledger.rebuildState();
    expect(vault.readRaw("Audit/state.json")).toContain('"agent-a":{"lastSeq":3}');
    expect(vault.readRaw("Audit/state.json")).toContain('"agent-b":{"lastSeq":7}');
  });
});

describe("AuditLedger.writeNote", () => {
  it("creates and replaces companion notes like digest.md", async () => {
    const vault = new FakeVault();
    const ledger = makeLedger(vault);
    await ledger.writeNote("Audit/digest.md", "v1");
    expect(vault.readRaw("Audit/digest.md")).toBe("v1");
    await ledger.writeNote("Audit/digest.md", "v2");
    expect(vault.readRaw("Audit/digest.md")).toBe("v2");
  });
});
