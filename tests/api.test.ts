import { describe, expect, it } from "vitest";
import { Vault } from "obsidian";
import { AuditLedger } from "../src/ledger";
import { AuditIngestor } from "../src/ingest";
import { CurtisAuditApiV1, createApi } from "../src/api";
import { sanitizeSettings, DEFAULT_SETTINGS } from "../src/settings";
import { encodeBlock } from "../src/protocol";
import { FakeVault } from "./fake-vault";

function makeApi(vault: FakeVault, cursors: Record<string, never> = {}) {
  const ledger = new AuditLedger(vault as unknown as Vault, "Audit");
  const ingestor = new AuditIngestor(vault as unknown as Vault, ledger, {
    messengerRoot: "Messenger",
    address: "audit",
  });
  ingestor.setCursors(cursors);
  const seen: string[] = [];
  const api = createApi(ledger, ingestor, {
    onReceipt: (r) => seen.push(r.id),
  });
  return { ledger, ingestor, api: api as CurtisAuditApiV1, seen };
}

describe("api.record", () => {
  it("writes a receipt with a claimed seq and fires the hook", async () => {
    const { api, ledger, seen } = makeApi(new FakeVault());
    const receipt = await api.record({
      agent: "curtis-ai-chat",
      action: "inference",
      model: "gpt-4o",
    });
    expect(receipt.seq).toBe(0);
    expect(await ledger.readAll()).toHaveLength(1);
    expect(seen).toEqual([receipt.id]);
  });

  it("requires an agent", async () => {
    const { api } = makeApi(new FakeVault());
    await expect(api.record({ action: "inference" })).rejects.toThrow(/agent/);
  });

  it("rejects invalid payloads with a readable error", async () => {
    const { api } = makeApi(new FakeVault());
    await expect(
      api.record({ agent: "curtis-ai-chat", status: "meh" })
    ).rejects.toThrow(/status/);
  });

  it("sequences successive records", async () => {
    const { api, ledger } = makeApi(new FakeVault());
    const a = await api.record({ agent: "curtis-ai-chat" });
    const b = await api.record({ agent: "curtis-ai-chat" });
    expect(b.seq).toBe(a.seq + 1);
    expect((await ledger.readAll()).map((r) => r.seq)).toEqual([0, 1]);
  });
});

describe("api.poll", () => {
  it("ingests inbox messages through the api surface", async () => {
    const vault = new FakeVault();
    vault.files.set(
      "Messenger/audit/inbox.md",
      "# Inbox — audit\n\n" +
        encodeBlock(
          "messenger",
          { id: "msg_1", from: "curtis-ai-chat", to: "audit", ts: "2026-10-10T00:00:00.000Z", replyTo: null },
          '{"action":"inference"}'
        )
    );
    const { api } = makeApi(vault);
    const result = await api.poll();
    expect(result.receipts).toBe(1);
  });
});

describe("sanitizeSettings", () => {
  it("falls back to defaults for garbage", () => {
    const s = sanitizeSettings({
      root: "..\\bad//path\\..",
      inboxAddress: "no good",
      pollSeconds: -5,
      retentionDays: Number.NaN,
      cursors: null,
    } as never);
    // cleanPath only normalizes slashes; garbage stays but sanitized
    expect(s.pollSeconds).toBeGreaterThanOrEqual(1);
    expect(s.retentionDays).toBe(0);
    expect(s.inboxAddress).toBe(DEFAULT_SETTINGS.inboxAddress);
    expect(s.cursors).toEqual({});
  });

  it("allows an empty messengerRoot (bus integration off)", () => {
    const s = sanitizeSettings({ messengerRoot: "" });
    expect(s.messengerRoot).toBe("");
  });

  it("clamps retention to sane bounds", () => {
    expect(sanitizeSettings({ retentionDays: 999999 }).retentionDays).toBe(36500);
  });
});
