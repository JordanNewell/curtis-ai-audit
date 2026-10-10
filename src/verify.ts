/**
 * Ledger verification. Without crypto this cannot prove what happened; it
 * can detect what a local-first journal cares about: receipts that fail to
 * parse, duplicate ids or sequence numbers, out-of-order edits, and holes in
 * per-agent sequence series (deletions — or the documented artifact of
 * pruning). SPEC.md states the guarantees and the limits plainly.
 */

import { AuditLedger } from "./ledger";
import { AuditReceiptV1 } from "./schema";

export interface VerifyIssue {
  severity: "error" | "warning";
  file: string;
  message: string;
}

export interface AgentSeqReport {
  agent: string;
  count: number;
  minSeq: number;
  maxSeq: number;
  missing: number[];
}

export interface VerifyReport {
  shards: number;
  receipts: number;
  malformed: number;
  issues: VerifyIssue[];
  agents: AgentSeqReport[];
  /** False only when an error-severity issue exists. */
  ok: boolean;
}

const MAX_LISTED = 20;

export async function verifyLedger(ledger: AuditLedger): Promise<VerifyReport> {
  const issues: VerifyIssue[] = [];
  const shards = ledger.listShards();
  const receipts: AuditReceiptV1[] = [];
  let malformed = 0;
  let reordered = 0;

  for (const path of shards) {
    const read = await ledger.readShard(path);
    for (const receipt of read.receipts) receipts.push(receipt);
    malformed += read.malformed;
    if (read.malformed > 0) {
      issues.push({
        severity: "warning",
        file: path,
        message: `${read.malformed} malformed or invalid block(s)`,
      });
    }
    for (let i = 1; i < read.receipts.length; i++) {
      if (Date.parse(read.receipts[i].recorded) < Date.parse(read.receipts[i - 1].recorded)) {
        reordered++;
      }
    }
  }
  if (reordered > 0) {
    issues.push({
      severity: "warning",
      file: "(ledger)",
      message:
        `${reordered} receipt(s) are out of recorded-order within their file — ` +
        "something edited or merged a ledger shard",
    });
  }

  const byId = new Map<string, number>();
  const byAgentSeq = new Map<string, number>();
  for (const r of receipts) {
    byId.set(r.id, (byId.get(r.id) ?? 0) + 1);
    const key = `${r.agent}#${r.seq}`;
    byAgentSeq.set(key, (byAgentSeq.get(key) ?? 0) + 1);
  }
  for (const [id, n] of byId) {
    if (n > 1) {
      issues.push({
        severity: "error",
        file: "(ledger)",
        message: `receipt id ${id} appears ${n} times`,
      });
    }
  }
  for (const [key, n] of byAgentSeq) {
    if (n > 1) {
      issues.push({
        severity: "error",
        file: "(ledger)",
        message: `${key} appears ${n} times (duplicate sequence number)`,
      });
    }
  }

  const agents = new Map<string, { count: number; min: number; max: number; seen: Set<number> }>();
  for (const r of receipts) {
    let a = agents.get(r.agent);
    if (!a) {
      a = { count: 0, min: r.seq, max: r.seq, seen: new Set<number>() };
      agents.set(r.agent, a);
    }
    a.count++;
    if (r.seq < a.min) a.min = r.seq;
    if (r.seq > a.max) a.max = r.seq;
    a.seen.add(r.seq);
  }
  const agentReports: AgentSeqReport[] = [];
  const sortedAgents = Array.from(agents.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [agent, a] of sortedAgents) {
    const missing: number[] = [];
    for (let s = a.min; s <= a.max; s++) {
      if (!a.seen.has(s)) missing.push(s);
    }
    if (missing.length > 0) {
      const listed =
        missing.slice(0, MAX_LISTED).join(", ") +
        (missing.length > MAX_LISTED ? ` … (+${missing.length - MAX_LISTED} more)` : "");
      issues.push({
        severity: "warning",
        file: "(ledger)",
        message:
          `${agent}: ${missing.length} missing sequence number(s) between ${a.min} and ${a.max} ` +
          `[${listed}] — deleted receipts, failed writes, or shards dropped by pruning`,
      });
    }
    agentReports.push({ agent, count: a.count, minSeq: a.min, maxSeq: a.max, missing });
  }

  return {
    shards: shards.length,
    receipts: receipts.length,
    malformed,
    issues,
    agents: agentReports,
    ok: !issues.some((i) => i.severity === "error"),
  };
}
