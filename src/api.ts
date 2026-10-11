/**
 * Public surface for other plugins and console use:
 *
 *   window.curtisAudit.record({ agent: "curtis-ai-chat", model: "gpt-4o", ... })
 *
 * This is the direct (in-process) path. The OM-1 inbox is the universal
 * path for anything outside the window.
 */

import { AuditLedger } from "./ledger";
import { AuditIngestor, IngestResult } from "./ingest";
import { AuditReceiptV1, ReceiptPayload, buildReceipt, validatePayload } from "./schema";
import { VerifyReport, verifyLedger } from "./verify";
import { buildDigest } from "./digest";
import { ReceiptQuery, queryReceipts } from "./query";

export interface CurtisAuditApiV1 {
  version: 1;
  /** Record one agent action directly. Throws on an invalid payload. */
  record(payload: ReceiptPayload): Promise<AuditReceiptV1>;
  /** One ingest pass over the OM-1 audit inbox. */
  poll(): Promise<IngestResult>;
  /** Scan the ledger for gaps, duplicates, and malformed blocks. */
  verify(): Promise<VerifyReport>;
  /** Markdown digest of the last `days` days (default 1). */
  digest(days?: number): Promise<string>;
  /** Filter the ledger: agent/action/status/model/subject, `recorded` bounds. */
  query(query?: ReceiptQuery): Promise<AuditReceiptV1[]>;
}

declare global {
  interface Window {
    curtisAudit?: CurtisAuditApiV1;
  }
}

export function createApi(
  ledger: AuditLedger,
  ingestor: AuditIngestor,
  hooks: { onReceipt?: (receipt: AuditReceiptV1) => void } = {}
): CurtisAuditApiV1 {
  return {
    version: 1,
    async record(payload) {
      const check = validatePayload(payload);
      if (!check.ok) {
        throw new Error(`Invalid audit payload: ${check.errors.join("; ")}`);
      }
      if (!payload.agent) {
        throw new Error("payload.agent is required — who made this inference?");
      }
      const receipt = buildReceipt(payload, { agent: payload.agent });
      receipt.seq = await ledger.claimSeq(receipt.agent);
      await ledger.append(receipt);
      await ledger.saveState();
      hooks.onReceipt?.(receipt);
      return receipt;
    },
    poll: () => ingestor.poll(),
    verify: () => verifyLedger(ledger),
    digest: (days) => buildDigest(ledger, { days: days ?? 1 }),
    query: async (query) => queryReceipts(await ledger.readAll(), query),
  };
}
