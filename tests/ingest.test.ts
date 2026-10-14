import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { AuditLedger, shardHeader } from "../src/ledger";
import { AuditIngestor, Cursor } from "../src/ingest";
import { buildReceipt } from "../src/schema";
import { encodeBlock } from "../src/protocol";
import { FakeVault, fakeFileManager } from "./fake-vault";

function busMessage(from: string, body: string, ts: string, id?: string): string {
  return encodeBlock(
    "messenger",
    { id: id ?? `msg_${Math.random().toString(36).slice(2, 10)}`, from, to: "audit", ts, replyTo: null },
    body
  );
}

function makeIngestor(vault: FakeVault, cursors: Record<string, Cursor> = {}) {
  const ledger = new AuditLedger(vault as unknown as Vault, fakeFileManager(vault), "Audit");
  const ingestor = new AuditIngestor(vault as unknown as Vault, ledger, {
    messengerRoot: "Messenger",
    address: "audit",
  });
  ingestor.setCursors(cursors);
  return { ledger, ingestor };
}

function writeInbox(vault: FakeVault, content: string): void {
  vault.files.set("Messenger/audit/inbox.md", "# Inbox — audit\n\n" + content);
}

describe("AuditIngestor", () => {
  it("ingests valid payloads, rejects junk, advances the cursor", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference","model":"gpt-4o"}', "2026-10-10T00:00:01.000Z", "msg_a") +
        busMessage("curtis-ai-chat", "not json at all", "2026-10-10T00:00:02.000Z", "msg_b") +
        busMessage("curtis-ai-chat", '{"action":"tool-call","tool":"search"}', "2026-10-10T00:00:03.000Z", "msg_c")
    );

    const result = await ingestor.poll();
    expect(result).toEqual({ delivered: 3, receipts: 2, rejected: 1, duplicates: 0 });

    const receipts = await ledger.readAll();
    expect(receipts.map((r) => r.action)).toEqual(["inference", "tool-call"]);
    expect(receipts.map((r) => r.seq)).toEqual([0, 1]);
    expect(receipts.every((r) => r.agent === "curtis-ai-chat")).toBe(true);
    expect(ingestor.getCursors()["Messenger/audit/inbox.md"].id).toBe("msg_c");

    // second poll: nothing new
    expect(await ingestor.poll()).toEqual({ delivered: 0, receipts: 0, rejected: 0, duplicates: 0 });
  });

  it("falls back to the bus sender as the agent", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage("research-agent", '{"action":"inference"}', "2026-10-10T00:00:00.000Z")
    );
    await ingestor.poll();
    expect((await ledger.readAll())[0].agent).toBe("research-agent");
  });

  it("honours an explicit agent in the payload over the sender", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage(
        "curtis-ai-chat",
        '{"agent":"sub-agent","action":"inference"}',
        "2026-10-10T00:00:00.000Z"
      )
    );
    await ingestor.poll();
    expect((await ledger.readAll())[0].agent).toBe("sub-agent");
  });

  it("redelivered messages become duplicates, not new receipts", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:01.000Z", "msg_a") +
        busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:02.000Z", "msg_b")
    );
    await ingestor.poll();
    expect(await ledger.readAll()).toHaveLength(2);

    // simulate a crash before the cursor save: same inbox, empty cursors
    const fresh = makeIngestor(vault).ingestor;
    const second = await fresh.poll();
    expect(second.duplicates).toBe(2);
    expect(second.receipts).toBe(0);
    expect(await ledger.readAll()).toHaveLength(2);
  });

  it("resumes from the cursor ts when the cursor id was GC'd", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:01.000Z", "msg_a") +
        busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:02.000Z", "msg_b")
    );
    await ingestor.poll();
    // cursor id no longer present (GC rewrote the file), ts fallback keeps order
    const stale: Record<string, Cursor> = {
      "Messenger/audit/inbox.md": { id: "msg_gone", ts: "2026-10-10T00:00:01.500Z" },
    };
    const fresh = makeIngestor(vault, stale).ingestor;
    const result = await fresh.poll();
    expect(result.delivered).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(await ledger.readAll()).toHaveLength(2);
  });

  it("does nothing when the inbox does not exist", async () => {
    const { ingestor } = makeIngestor(new FakeVault());
    expect(await ingestor.poll()).toEqual({ delivered: 0, receipts: 0, rejected: 0, duplicates: 0 });
  });
});

describe("AuditIngestor (cursor and dedupe edges)", () => {
  it("advances the cursor past rejected payloads so they are not retried", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference","status":"meh"}', "2026-10-10T00:00:01.000Z", "msg_bad")
    );
    expect(await ingestor.poll()).toMatchObject({ delivered: 1, rejected: 1 });
    expect(ingestor.getCursors()["Messenger/audit/inbox.md"].id).toBe("msg_bad");

    // the same junk on a later poll is not redelivered
    expect(await ingestor.poll()).toEqual({ delivered: 0, receipts: 0, rejected: 0, duplicates: 0 });
    expect(await ledger.readAll()).toHaveLength(0);
  });

  it("rejects payloads that are valid JSON but not objects", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", "[1,2,3]", "2026-10-10T00:00:01.000Z", "msg_arr") +
        busMessage("curtis-ai-chat", '"just a string"', "2026-10-10T00:00:02.000Z", "msg_str")
    );
    expect(await ingestor.poll()).toMatchObject({ delivered: 2, rejected: 2 });
    expect(await ledger.readAll()).toHaveLength(0);
  });

  it("only checks recent shards for redelivery (documented limit)", async () => {
    const vault = new FakeVault();
    const day = (offset: number): string =>
      new Date(Date.parse("2026-10-05T00:00:00.000Z") + offset * 86400000)
        .toISOString()
        .slice(0, 10);
    const seeded = (d: string, hour: number, sourceId: string): string => {
      const receipt = buildReceipt(
        { agent: "curtis-ai-chat", action: "inference" },
        { agent: "curtis-ai-chat", sourceId }
      );
      receipt.seq = 0;
      receipt.recorded = `${d}T0${hour}:00:00.000Z`;
      return encodeBlock("curtis-audit", receipt as unknown as Record<string, unknown>, "body");
    };
    // the oldest shard carries msg_old; the dedupe window (last 2 shards)
    // covers only day(1) and day(2), whose receipts have other source ids
    vault.files.set(
      `Audit/ledger/${day(0)}.md`,
      shardHeader(day(0)) + seeded(day(0), 1, "msg_old")
    );
    vault.files.set(`Audit/ledger/${day(1)}.md`, shardHeader(day(1)) + seeded(day(1), 1, "msg_other1"));
    vault.files.set(`Audit/ledger/${day(2)}.md`, shardHeader(day(2)) + seeded(day(2), 1, "msg_other2"));

    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:00.000Z", "msg_old")
    );
    const { ledger, ingestor } = makeIngestor(vault);
    const result = await ingestor.poll();
    // not caught by the window → written again; ledger keeps all four
    expect(result.receipts).toBe(1);
    expect(await ledger.readAll()).toHaveLength(4);
  });

  it("ts fallback includes equal-ts messages; sourceId dedupe absorbs the redelivery", async () => {
    const vault = new FakeVault();
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:01.000Z", "msg_a") +
        busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:02.000Z", "msg_b") +
        busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:03.000Z", "msg_c")
    );
    const { ledger, ingestor } = makeIngestor(vault);
    await ingestor.poll(); // delivers all three; cursor at msg_c

    // crash before the cursor save: a fresh ingestor falls back to a stale ts
    // that sits exactly on msg_b
    const stale: Record<string, Cursor> = {
      "Messenger/audit/inbox.md": { id: "msg_gone", ts: "2026-10-10T00:00:02.000Z" },
    };
    const result = await makeIngestor(vault, stale).ingestor.poll();
    // msg_b sits exactly at the cursor: delivered again (>=, not >), counted
    // as a duplicate by the shard dedupe — never skipped forever, never
    // written twice. msg_c redelivers too and is likewise deduped.
    expect(result.delivered).toBe(2);
    expect(result.duplicates).toBe(2);
    expect(result.receipts).toBe(0);
    expect(await ledger.readAll()).toHaveLength(3);
  });

  it("a corrupt cursor (non-string id/ts) does not stall the inbox", async () => {
    const vault = new FakeVault();
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:01.000Z", "msg_a")
    );
    const corrupt = {
      "Messenger/audit/inbox.md": { id: 42, ts: undefined } as unknown as Cursor,
    };
    const { ledger, ingestor } = makeIngestor(vault, corrupt);
    const result = await ingestor.poll();
    // deterministic skip-or-reject: the garbage cursor is ignored, the
    // message is delivered normally
    expect(result.delivered).toBe(1);
    expect(result.receipts).toBe(1);
    expect(await ledger.readAll()).toHaveLength(1);
  });

  it("an unparseable message ts is treated as pending and rejected, not silently skipped", async () => {
    const vault = new FakeVault();
    writeInbox(
      vault,
      busMessage("curtis-ai-chat", '{"action":"inference"}', "not a date", "msg_bad") +
        busMessage("curtis-ai-chat", '{"action":"inference"}', "2026-10-10T00:00:03.000Z", "msg_ok")
    );
    const stale: Record<string, Cursor> = {
      "Messenger/audit/inbox.md": { id: "msg_gone", ts: "2026-10-10T00:00:00.000Z" },
    };
    const { ledger, ingestor } = makeIngestor(vault, stale);
    const result = await ingestor.poll();
    // the garbage-ts message becomes pending, ingestMessage rejects it (its
    // ts fails payload validation), and the cursor still advances past it
    expect(result.delivered).toBe(2);
    expect(result.rejected).toBe(1);
    expect(result.receipts).toBe(1);
    expect(ingestor.getCursors()["Messenger/audit/inbox.md"].id).toBe("msg_ok");
    expect(await ledger.readAll()).toHaveLength(1);
  });

  it("shallow-copies the cursor map on the way in and out (nested cursors are shared)", () => {
    const { ingestor } = makeIngestor(new FakeVault());
    const mine: Record<string, Cursor> = {
      "Messenger/audit/inbox.md": { id: "msg_1", ts: "2026-10-10T00:00:00.000Z" },
    };
    ingestor.setCursors(mine);
    const outside = ingestor.getCursors();
    outside["extra"] = { id: "x", ts: "t" };
    // the map itself is copied: new keys do not leak through either direction
    expect(ingestor.getCursors()["extra"]).toBeUndefined();
    expect(Object.keys(mine)).toHaveLength(1);
    // but the copy is shallow: mutating a nested cursor object is visible both
    // ways (documented current behavior — settings.ts keeps the same reference)
    outside["Messenger/audit/inbox.md"].id = "mutated";
    expect(mine["Messenger/audit/inbox.md"].id).toBe("mutated");
  });

  it("a poll with only junk leaves state.json unwritten", async () => {
    const vault = new FakeVault();
    const { ingestor } = makeIngestor(vault);
    writeInbox(vault, busMessage("curtis-ai-chat", "junk", "2026-10-10T00:00:01.000Z"));
    await ingestor.poll();
    expect(vault.readRaw("Audit/state.json")).toBeUndefined();
  });
});
