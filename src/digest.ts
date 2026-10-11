/**
 * Human-readable digest of recent ledger activity, written to
 * `<root>/digest.md`. Counts and tables are derived from a full ledger read —
 * fine at journal volume; swap for a real index if that ever changes.
 */

import { AuditLedger } from "./ledger";
import { AuditReceiptV1 } from "./schema";

/** Compact wall-clock formatting for the digest summary line. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export async function buildDigest(
  ledger: AuditLedger,
  opts: { days?: number; now?: Date } = {}
): Promise<string> {
  const days = Math.max(1, Math.floor(opts.days ?? 1));
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - days * 86400000;
  const all: AuditReceiptV1[] = [];
  for (const receipt of await ledger.readAll()) {
    if (Date.parse(receipt.recorded) >= cutoff) all.push(receipt);
  }

  const lines: string[] = [];
  lines.push("# Audit digest");
  lines.push("");
  lines.push(
    `Period: last ${days} day${days === 1 ? "" : "s"} (through ${now.toISOString()}). ` +
      `Ledger: \`${ledger.ledgerDir}/\`.`
  );
  lines.push("");
  if (all.length === 0) {
    lines.push("No receipts in this period.");
    return lines.join("\n") + "\n";
  }

  let okCount = 0;
  let errCount = 0;
  let abortCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let totalMs = 0;
  for (const r of all) {
    if (r.status === "ok") okCount++;
    else if (r.status === "error") errCount++;
    else abortCount++;
    if (typeof r.tokens?.input === "number") tokensIn += r.tokens.input;
    if (typeof r.tokens?.output === "number") tokensOut += r.tokens.output;
    if (typeof r.durationMs === "number") totalMs += r.durationMs;
  }
  const tokenPart =
    tokensIn > 0 || tokensOut > 0 ? `, ${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out` : "";
  const durationPart = totalMs > 0 ? `, total duration ${formatDuration(totalMs)}` : "";
  lines.push(
    `**${all.length}** receipts — ${okCount} ok, ${errCount} error, ${abortCount} aborted${tokenPart}${durationPart}.`
  );
  lines.push("");

  const byDay = new Map<string, { total: number; ok: number; error: number; aborted: number }>();
  for (const r of all) {
    const day = r.recorded.slice(0, 10);
    let row = byDay.get(day);
    if (!row) {
      row = { total: 0, ok: 0, error: 0, aborted: 0 };
      byDay.set(day, row);
    }
    row.total++;
    if (r.status === "ok") row.ok++;
    else if (r.status === "error") row.error++;
    else row.aborted++;
  }
  // one row per calendar day only makes sense once there is more than one
  if (byDay.size > 1) {
    lines.push("### By day");
    lines.push("");
    lines.push("| day | receipts | ok | error | aborted |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const day of Array.from(byDay.keys()).sort()) {
      const row = byDay.get(day) as { total: number; ok: number; error: number; aborted: number };
      lines.push(`| ${day} | ${row.total} | ${row.ok} | ${row.error} | ${row.aborted} |`);
    }
    lines.push("");
  }

  const agentRows = new Map<
    string,
    { total: number; ok: number; error: number; aborted: number; tokensIn?: number; tokensOut?: number }
  >();
  const actionCounts = new Map<string, number>();
  for (const r of all) {
    let row = agentRows.get(r.agent);
    if (!row) {
      row = { total: 0, ok: 0, error: 0, aborted: 0 };
      agentRows.set(r.agent, row);
    }
    row.total++;
    if (r.status === "ok") row.ok++;
    else if (r.status === "error") row.error++;
    else row.aborted++;
    if (typeof r.tokens?.input === "number") {
      row.tokensIn = (row.tokensIn ?? 0) + r.tokens.input;
    }
    if (typeof r.tokens?.output === "number") {
      row.tokensOut = (row.tokensOut ?? 0) + r.tokens.output;
    }
    actionCounts.set(r.action, (actionCounts.get(r.action) ?? 0) + 1);
  }

  lines.push("| agent | receipts | ok | error | aborted | tokens in | tokens out |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const agent of Array.from(agentRows.keys()).sort()) {
    const row = agentRows.get(agent) as {
      total: number;
      ok: number;
      error: number;
      aborted: number;
      tokensIn?: number;
      tokensOut?: number;
    };
    const tin = row.tokensIn !== undefined ? row.tokensIn.toLocaleString() : "—";
    const tout = row.tokensOut !== undefined ? row.tokensOut.toLocaleString() : "—";
    lines.push(`| ${agent} | ${row.total} | ${row.ok} | ${row.error} | ${row.aborted} | ${tin} | ${tout} |`);
  }
  lines.push("");
  lines.push("| action | count |");
  lines.push("| --- | --- |");
  const actionsSorted = Array.from(actionCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [action, count] of actionsSorted) {
    lines.push(`| ${action} | ${count} |`);
  }
  lines.push("");

  const errors = all.filter((r) => r.status === "error").slice(-10).reverse();
  if (errors.length > 0) {
    lines.push(`### Errors (${errCount} total, showing up to 10)`);
    lines.push("");
    for (const r of errors) {
      const label = r.summary ?? r.model ?? r.provider ?? "";
      lines.push(`- \`${r.id}\` **${r.agent}** ${label} — ${r.recorded}`);
    }
    lines.push("");
  }

  const latest = all.slice(-10).reverse();
  lines.push("### Latest receipts");
  lines.push("");
  for (const r of latest) {
    const model = r.model ? ` \`${r.model}\`` : "";
    lines.push(`- \`${r.id}\` **${r.action}** ${r.agent}${model} — ${r.recorded}`);
  }
  return lines.join("\n") + "\n";
}
