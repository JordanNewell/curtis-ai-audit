/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

/**
 * The ledger watches itself. Retention pruning rewrites shards and leaves
 * sequence gaps (SPEC §7); recording each pass as an ordinary receipt keeps
 * the explanation inside the journal instead of only in a console line.
 */

import { AuditReceiptV1 } from "./schema";
import { CurtisAuditApiV1 } from "./api";

/** Address the plugin files its own receipts under (OM-1 §2: the plugin id). */
export const AUDIT_AGENT = "curtis-ai-audit";

export async function recordPruneReceipt(
  api: CurtisAuditApiV1,
  dropped: number,
  retentionDays: number
): Promise<AuditReceiptV1> {
  return api.record({
    agent: AUDIT_AGENT,
    action: "prune",
    summary: `Pruned ${dropped} receipt(s) older than ${retentionDays} day(s)`,
    detail: { dropped, retentionDays },
  });
}
