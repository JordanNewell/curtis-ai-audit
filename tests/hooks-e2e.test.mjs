import { describe, expect, it } from "vitest";
import { FakeVault, fakeFileManager } from "./fake-vault";
import { AuditLedger } from "../src/ledger";
import { AuditIngestor } from "../src/ingest";
import { verifyLedger } from "../src/verify";
import { buildBlock, newId } from "../bin/curtis-audit-file.mjs";
import { FAKE_SECRETS, POSITIVE, junkBodies } from "./fixtures/hook-payloads.mjs";

/** The whole Path C chain with in-memory vaults: payload → writer → inbox → ingest. */
function makeIngestor(vault) {
  const ledger = new AuditLedger(vault, fakeFileManager(vault), "Audit");
  const ingestor = new AuditIngestor(vault, ledger, {
    messengerRoot: "Messenger",
    address: "audit",
  });
  return { ledger, ingestor };
}

const INBOX = "Messenger/audit/inbox.md";
const HEADER = "# Inbox — audit\n\n";

function hookBlock(fixture, agent = "claude-code", overrides = {}) {
  // What a real hook does: JSON on stdin, writer files one block.
  return buildBlock({ from: agent, ts: new Date().toISOString(), id: newId() }, fixture, overrides);
}

describe("Path C whole chain", () => {
  it("every realistic hook payload survives writer → inbox → ingest → ledger", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    const blocks = POSITIVE.map(([name, fixture]) =>
      hookBlock(fixture, name.startsWith("codex") ? "codex" : name.startsWith("opencode") ? "opencode" : "claude-code",
        name === "claudeStop" || name.startsWith("codex") ? { action: "agent-turn" } : {})
    );
    vault.files.set(INBOX, HEADER + blocks.join(""));

    const result = await ingestor.poll();
    expect(result.delivered).toBe(POSITIVE.length);
    expect(result.rejected).toBe(0);
    expect(result.receipts).toBe(POSITIVE.length);

    const receipts = await ledger.readAll();
    expect(receipts).toHaveLength(POSITIVE.length);
    // per-agent sequences are independent, assigned by the ledger
    const byAgent = new Map();
    for (const r of receipts) byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + 1);
    expect(byAgent.get("claude-code")).toBe(9);
    expect(byAgent.get("codex")).toBe(1);
    expect(byAgent.get("opencode")).toBe(1);

    // spot-check the mapping end to end
    const edit = receipts.find((r) => r.subject === "Notes/physics.md");
    expect(edit?.action).toBe("tool-call");
    expect(edit?.summary).toBe("Edit on Notes/physics.md");
    const codexTurn = receipts.find((r) => r.agent === "codex");
    expect(codexTurn?.action).toBe("agent-turn");
    expect(codexTurn?.summary).toBe("agent-turn-complete");
    const claudeStop = receipts.find((r) => r.subject === undefined && r.summary === "Stop");
    expect(claudeStop?.agent).toBe("claude-code");

    const report = await verifyLedger(ledger);
    expect(report.ok).toBe(true);
  });

  it("no fake secret from any payload can reach the ledger", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    vault.files.set(INBOX, HEADER + POSITIVE.map(([, f]) => hookBlock(f)).join(""));
    await ingestor.poll();
    const raw = JSON.stringify(await ledger.readAll());
    for (const secret of FAKE_SECRETS) {
      expect(raw).not.toContain(secret);
    }
  });

  it("redelivery after a crash window is deduped by source id", async () => {
    const vault = new FakeVault();
    const { ingestor } = makeIngestor(vault);
    const blocks = POSITIVE.map(([, f]) => hookBlock(f));
    vault.files.set(INBOX, HEADER + blocks.join(""));
    const first = await ingestor.poll();
    expect(first.receipts).toBe(POSITIVE.length);

    // Simulate the at-least-once crash window: same ids delivered again.
    vault.files.set(INBOX, HEADER + blocks.join("") + blocks.join(""));
    const second = await ingestor.poll();
    expect(second.receipts).toBe(0);
    expect(second.duplicates).toBe(POSITIVE.length);
  });

  it("junk bodies are rejected and never enter the ledger", async () => {
    const vault = new FakeVault();
    const { ledger, ingestor } = makeIngestor(vault);
    const junk = junkBodies
      .map(
        (body, i) =>
          `<!-- messenger: {"id":"msg_junk${i}","from":"junk-agent","to":"audit","ts":"2026-10-11T00:0${i}:00.000Z","replyTo":null} -->\n${body}\n<!-- /messenger -->\n\n`
      )
      .join("");
    vault.files.set(INBOX, HEADER + junk);
    const result = await ingestor.poll();
    expect(result.rejected).toBe(junkBodies.length);
    expect(result.receipts).toBe(0);
    expect(await ledger.readAll()).toHaveLength(0);
  });
});
