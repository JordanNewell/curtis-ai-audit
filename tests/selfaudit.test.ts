import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { AuditLedger } from "../src/ledger";
import { AuditIngestor } from "../src/ingest";
import { createApi } from "../src/api";
import { AUDIT_AGENT, recordPruneReceipt } from "../src/selfaudit";
import { validateReceipt } from "../src/schema";
import { FakeVault, fakeFileManager } from "./fake-vault";

function makeApi(vault: FakeVault) {
  const ledger = new AuditLedger(vault as unknown as Vault, fakeFileManager(vault), "Audit");
  const ingestor = new AuditIngestor(vault as unknown as Vault, ledger, {
    messengerRoot: "Messenger",
    address: "audit",
  });
  return createApi(ledger, ingestor);
}

describe("selfaudit", () => {
  it("uses the plugin id as the agent address (OM-1 §2)", () => {
    expect(AUDIT_AGENT).toBe("curtis-ai-audit");
  });

  it("records a prune pass as a fully valid ordinary receipt", async () => {
    const api = makeApi(new FakeVault());
    const receipt = await recordPruneReceipt(api, 12, 90);
    expect(receipt.agent).toBe(AUDIT_AGENT);
    expect(receipt.action).toBe("prune");
    expect(receipt.status).toBe("ok");
    expect(receipt.seq).toBe(0);
    expect(receipt.sourceId).toBeUndefined();
    expect(receipt.detail).toEqual({ dropped: 12, retentionDays: 90 });
    expect(receipt.summary).toBe("Pruned 12 receipt(s) older than 90 day(s)");
    expect(validateReceipt(receipt).ok).toBe(true);
  });

  it("lands in the ledger like any other receipt and consumes a seq", async () => {
    const vault = new FakeVault();
    const api = makeApi(vault);
    await recordPruneReceipt(api, 0, 7);
    await recordPruneReceipt(api, 3, 7);
    const receipts = await api.query({ agent: AUDIT_AGENT, order: "asc" });
    expect(receipts.map((r) => r.seq)).toEqual([0, 1]);
    expect(receipts[0].detail).toEqual({ dropped: 0, retentionDays: 7 });
    expect(receipts[0].summary).toContain("Pruned 0 receipt(s)");
  });
});
