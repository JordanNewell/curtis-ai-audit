/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

/**
 * Ingest: poll the OM-1 audit inbox (a normal messenger inbox) and convert
 * message bodies into receipts. Any OM-1 participant — plugin, agent, or a
 * shell one-liner — can submit receipts by appending to the inbox; this runs
 * standalone, so the messenger plugin does not need to be installed.
 *
 * Delivery is at-least-once (OM-1 SPEC §4): cursors are saved after each
 * poll, so a crash can redeliver. Dedupe on the source message id makes
 * redelivery harmless.
 */

import { TFile, Vault, normalizePath } from "obsidian";
import { AuditLedger } from "./ledger";
import { MailEnvelope, parseInbox } from "./protocol";
import { ReceiptPayload, buildReceipt, validatePayload } from "./schema";

export interface Cursor {
  id: string;
  ts: string;
}

export interface IngestResult {
  /** OM-1 messages past the cursor this pass. */
  delivered: number;
  /** Receipts written to the ledger. */
  receipts: number;
  /** Bodies that were not valid audit.v1 payloads. */
  rejected: number;
  /** Redelivered messages already in the ledger. */
  duplicates: number;
}

export type IngestOutcome = "receipt" | "duplicate" | "rejected";

export class AuditIngestor {
  private cursors: Record<string, Cursor> = {};
  private seenSourceIds = new Set<string>();

  constructor(
    private vault: Vault,
    private ledger: AuditLedger,
    private opts: { messengerRoot: string; address: string }
  ) {}

  get inboxPath(): string {
    return normalizePath(`${this.opts.messengerRoot}/${this.opts.address}/inbox.md`);
  }

  setCursors(cursors: Record<string, Cursor>): void {
    this.cursors = { ...cursors };
  }

  getCursors(): Record<string, Cursor> {
    return { ...this.cursors };
  }

  /** One poll pass. Advances the in-memory cursor; the caller persists it. */
  async poll(): Promise<IngestResult> {
    const result: IngestResult = { delivered: 0, receipts: 0, rejected: 0, duplicates: 0 };
    const file = this.vault.getAbstractFileByPath(this.inboxPath);
    if (!(file instanceof TFile)) return result;
    const messages = parseInbox(await this.vault.read(file));
    const pending = pendingAfter(messages, this.cursors[this.inboxPath] ?? null);
    for (const message of pending) {
      result.delivered++;
      const outcome = await this.ingestMessage(message);
      if (outcome === "receipt") result.receipts++;
      else if (outcome === "duplicate") result.duplicates++;
      else result.rejected++;
      this.cursors[this.inboxPath] = { id: message.id, ts: message.ts };
    }
    if (result.delivered > 0) await this.ledger.saveState();
    return result;
  }

  private async ingestMessage(message: MailEnvelope): Promise<IngestOutcome> {
    if (this.seenSourceIds.has(message.id)) return "duplicate";
    // an unparseable envelope ts would poison the cursor fallback if stored —
    // reject it here so it is counted and the cursor advances past it
    if (Number.isNaN(Date.parse(message.ts))) return "rejected";
    const body = message.body.trim();
    if (!body.startsWith("{")) return "rejected";
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return "rejected";
    }
    const check = validatePayload(payload);
    if (!check.ok) return "rejected";
    if (await this.sourceAlreadyIngested(message.id)) return "duplicate";
    const agent = (payload as ReceiptPayload).agent ?? message.from;
    const receipt = buildReceipt(payload as ReceiptPayload, { agent, sourceId: message.id });
    receipt.seq = await this.ledger.claimSeq(agent);
    await this.ledger.append(receipt);
    this.seenSourceIds.add(message.id);
    return "receipt";
  }

  /**
   * Best-effort idempotence: check recent shards for this source message id.
   * Only recent shards are checked — this guards the crash window between
   * ledger append and cursor save, not arbitrary replay of ancient mail.
   */
  private async sourceAlreadyIngested(sourceId: string): Promise<boolean> {
    const shards = this.ledger.listShards().slice(-2);
    for (const path of shards) {
      const read = await this.ledger.readShard(path);
      if (read.receipts.some((r) => r.sourceId === sourceId)) return true;
    }
    return false;
  }
}

function pendingAfter(messages: MailEnvelope[], cursor: Cursor | null): MailEnvelope[] {
  // a corrupt cursor (garbage written by an older version, or a hand-edited
  // settings file) must not NaN-compare the whole inbox into a permanent
  // stall — ignore it and start over; the sourceId dedupe absorbs redelivery
  if (!cursor || typeof cursor.id !== "string" || typeof cursor.ts !== "string") {
    return messages;
  }
  const idx = messages.findIndex((m) => m.id === cursor.id);
  if (idx >= 0) return messages.slice(idx + 1);
  const ts = Date.parse(cursor.ts);
  if (Number.isNaN(ts)) return messages;
  return messages.filter((m) => {
    // unparseable message ts stays pending so ingestMessage rejects and
    // counts it; the boundary is inclusive (>=) — an equal-ts redelivery is
    // caught by the sourceId dedupe instead of being skipped forever
    const t = Date.parse(m.ts);
    return Number.isNaN(t) ? true : t >= ts;
  });
}
