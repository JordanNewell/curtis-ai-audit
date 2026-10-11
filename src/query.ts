/**
 * The read side of the API: filter receipts for other plugins, dashboards,
 * and console use. Time bounds apply to `recorded` — the local fact about
 * when the receipt was written — not `ts`, which is the sender's claim.
 * That matches shard placement and the digest, and means a query's window
 * cannot be re-scoped by re-claiming timestamps in a payload.
 */

import { AuditReceiptV1, RECEIPT_STATUSES, ReceiptStatus } from "./schema";

export interface ReceiptQuery {
  /** Exact agent address. */
  agent?: string;
  /** Exact action, as stored (normalized lowercase, e.g. "tool-call"). */
  action?: string;
  status?: ReceiptStatus;
  /** Exact model id. */
  model?: string;
  /** Subject prefix: "Notes/" matches every subject under Notes. */
  subject?: string;
  /** Inclusive lower bound on `recorded` (ISO string or epoch ms). */
  since?: string | number;
  /** Inclusive upper bound on `recorded` (ISO string or epoch ms). */
  until?: string | number;
  /** Oldest-first ("asc") or newest-first ("desc", the default). */
  order?: "asc" | "desc";
  /** Maximum receipts returned, applied after ordering. */
  limit?: number;
}

function boundMs(value: string | number, label: string): number {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`query.${label} must be an ISO timestamp or epoch ms`);
  }
  return ms;
}

export function queryReceipts(
  receipts: AuditReceiptV1[],
  query: ReceiptQuery = {}
): AuditReceiptV1[] {
  if (query.order !== undefined && query.order !== "asc" && query.order !== "desc") {
    throw new Error('query.order must be "asc" or "desc"');
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
    throw new Error("query.limit must be a positive integer");
  }
  if (
    query.status !== undefined &&
    !(RECEIPT_STATUSES as readonly string[]).includes(query.status)
  ) {
    throw new Error(`query.status must be one of ${RECEIPT_STATUSES.join("|")}`);
  }
  const sinceMs = query.since !== undefined ? boundMs(query.since, "since") : -Infinity;
  const untilMs = query.until !== undefined ? boundMs(query.until, "until") : Infinity;

  const matched = receipts.filter((r) => {
    if (query.agent !== undefined && r.agent !== query.agent) return false;
    if (query.action !== undefined && r.action !== query.action) return false;
    if (query.status !== undefined && r.status !== query.status) return false;
    if (query.model !== undefined && r.model !== query.model) return false;
    if (query.subject !== undefined && !(r.subject ?? "").startsWith(query.subject)) return false;
    const ms = Date.parse(r.recorded);
    return ms >= sinceMs && ms <= untilMs;
  });

  // oldest first, then by seq so equal `recorded` values keep write order
  matched.sort((a, b) => {
    const byRecorded = Date.parse(a.recorded) - Date.parse(b.recorded);
    if (byRecorded !== 0) return byRecorded;
    return a.seq - b.seq;
  });
  if (query.order !== "asc") matched.reverse();
  if (query.limit !== undefined) matched.length = Math.min(matched.length, query.limit);
  return matched;
}
