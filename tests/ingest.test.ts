import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { AuditLedger } from "../src/ledger";
import { AuditIngestor, Cursor } from "../src/ingest";
import { encodeBlock } from "../src/protocol";
import { FakeVault } from "./fake-vault";

function busMessage(from: string, body: string, ts: string, id?: string): string {
  return encodeBlock(
    "messenger",
    { id: id ?? `msg_${Math.random().toString(36).slice(2, 10)}`, from, to: "audit", ts, replyTo: null },
    body
  );
}

function makeIngestor(vault: FakeVault, cursors: Record<string, Cursor> = {}) {
  const ledger = new AuditLedger(vault as unknown as Vault, "Audit");
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
