/**
 * Opt-in integration test over a REAL session corpus. Runs only when
 * CURTIS_REAL_INBOX points at an inbox file produced by
 * bin/sessions-to-inbox.mjs — clean checkouts and CI skip it. The corpus
 * stays on disk outside the repo; nothing here commits user content.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Vault } from "obsidian";
import { FakeVault } from "./fake-vault";
import { AuditLedger } from "../src/ledger";
import { AuditIngestor } from "../src/ingest";
import { verifyLedger } from "../src/verify";
import { buildDigest } from "../src/digest";

const inboxPath = process.env.CURTIS_REAL_INBOX;
const suite = inboxPath ? describe : describe.skip;

suite("real vault corpus", () => {
  it("ingests the whole session corpus cleanly", async () => {
    const content = readFileSync(inboxPath as string, "utf8");
    const vault = new FakeVault({ "Messenger/audit/inbox.md": content });
    const ledger = new AuditLedger(vault as unknown as Vault, "Audit");
    const ingestor = new AuditIngestor(vault as unknown as Vault, ledger, {
      messengerRoot: "Messenger",
      address: "audit",
    });

    const result = await ingestor.poll();
    const receipts = await ledger.readAll();
    const agents = new Map<string, number>();
    const actions = new Map<string, number>();
    for (const r of receipts) {
      agents.set(r.agent, (agents.get(r.agent) ?? 0) + 1);
      actions.set(r.action, (actions.get(r.action) ?? 0) + 1);
    }
    console.log("[real-corpus] ingest:", result);
    console.log("[real-corpus] agents:", Object.fromEntries(agents));
    console.log("[real-corpus] actions:", Object.fromEntries(actions));

    const report = await verifyLedger(ledger);
    console.log(
      `[real-corpus] verify: ok=${report.ok} receipts=${report.receipts} shards=${report.shards} issues=${report.issues.length}`
    );
    const oldest = receipts.reduce((a, b) => (a.ts < b.ts ? a : b));
    const newest = receipts.reduce((a, b) => (a.ts > b.ts ? a : b));
    console.log(`[real-corpus] span: ${oldest.ts} → ${newest.ts}`);
    console.log("[real-corpus] samples:");
    for (const r of receipts.slice(0, 5)) {
      console.log(`  - [seq ${r.seq}] ${r.subject} — ${r.summary}`);
    }

    // What the user actually sees: the shard as written, and the digest.
    const shardPath = ledger.shardPath(new Date().toISOString().slice(0, 10));
    const raw = (vault as unknown as { readRaw(p: string): string | undefined }).readRaw(shardPath) ?? "";
    console.log(`[real-corpus] shard preview (${shardPath}):`);
    console.log(raw.split("\n").slice(0, 26).join("\n"));
    const digest = await buildDigest(ledger, { days: 1 });
    console.log("[real-corpus] digest preview:");
    console.log(digest.split("\n").slice(0, 18).join("\n"));

    expect(result.receipts).toBeGreaterThan(0);
    expect(result.rejected).toBe(0);
    expect(receipts.length).toBe(result.receipts);
    expect(report.ok).toBe(true);
  });
});
