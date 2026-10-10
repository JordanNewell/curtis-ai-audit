/**
 * audit.v1 — the receipt schema.
 *
 * Receipts are the unit of record: one agent action (usually one inference),
 * one receipt. The envelope of a ledger block is the whole receipt as
 * canonical JSON; the schema is versioned from day one so later formats can
 * coexist, and bodies stay canonicalization-friendly so a hash chain can be
 * layered over history without reformatting it.
 */

import { ADDRESS_RE, newId } from "./protocol";

export const RECEIPT_SCHEMA = "audit.v1";

export const RECEIPT_STATUSES = ["ok", "error", "aborted"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

const ACTION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface ReceiptTokens {
  input?: number;
  output?: number;
}

export interface AuditReceiptV1 {
  schema: string;
  /** Receipt id, independent of any bus message id. `rcp_` + base36 time + random. */
  id: string;
  /** Per-agent sequence number, assigned by the ledger at write time. */
  seq: number;
  /** Address of the agent that performed the action. */
  agent: string;
  /** When the action happened (ISO 8601 UTC). */
  ts: string;
  /** When the receipt was written to the ledger (ISO 8601 UTC). */
  recorded: string;
  /** Open vocabulary, lowercase: inference, tool-call, note-write, search, … */
  action: string;
  status: ReceiptStatus;
  provider?: string;
  model?: string;
  durationMs?: number;
  tokens?: ReceiptTokens;
  /** Vault path or other object the action was about. */
  subject?: string;
  /** One human-readable line. */
  summary?: string;
  /** OM-1 message id when the receipt arrived via the bus. */
  sourceId?: string;
  /** Caller-defined payload. Must be JSON-serializable. */
  detail?: unknown;
}

/** What senders provide; the ledger fills in id, seq, recorded. */
export interface ReceiptPayload {
  agent?: string;
  ts?: string;
  action?: string;
  status?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  tokens?: ReceiptTokens;
  subject?: string;
  summary?: string;
  detail?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const isNonNegativeNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

export function validatePayload(payload: unknown): ValidationResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  const p = payload as ReceiptPayload;
  const errors: string[] = [];
  if (p.agent !== undefined && (typeof p.agent !== "string" || !ADDRESS_RE.test(p.agent))) {
    errors.push(`invalid agent address: ${String(p.agent)}`);
  }
  if (p.ts !== undefined && (typeof p.ts !== "string" || Number.isNaN(Date.parse(p.ts)))) {
    errors.push(`invalid ts: ${String(p.ts)}`);
  }
  if (p.status !== undefined && !(RECEIPT_STATUSES as readonly string[]).includes(p.status)) {
    errors.push(`status must be one of ${RECEIPT_STATUSES.join("|")}`);
  }
  if (p.action !== undefined && (typeof p.action !== "string" || !ACTION_RE.test(normalizeAction(p.action)))) {
    errors.push(`invalid action: ${String(p.action)}`);
  }
  if (p.durationMs !== undefined && !isNonNegativeNumber(p.durationMs)) {
    errors.push("durationMs must be a non-negative number");
  }
  if (p.tokens !== undefined) {
    if (typeof p.tokens !== "object" || p.tokens === null) {
      errors.push("tokens must be an object");
    } else {
      const t = p.tokens as ReceiptTokens;
      for (const key of ["input", "output"] as const) {
        if (t[key] !== undefined && !isNonNegativeNumber(t[key])) {
          errors.push(`tokens.${key} must be a non-negative number`);
        }
      }
    }
  }
  try {
    JSON.stringify(payload);
  } catch (err) {
    errors.push(`payload is not JSON-serializable: ${(err as Error).message}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Validate a parsed ledger-block header as a complete receipt. */
export function validateReceipt(value: unknown): ValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["receipt must be a JSON object"] };
  }
  const r = value as Partial<AuditReceiptV1> & Record<string, unknown>;
  const errors: string[] = [];
  if (r.schema !== RECEIPT_SCHEMA) errors.push(`schema must be "${RECEIPT_SCHEMA}"`);
  if (typeof r.id !== "string" || !r.id) errors.push("id must be a non-empty string");
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) {
    errors.push("seq must be a non-negative integer");
  }
  if (typeof r.agent !== "string" || !ADDRESS_RE.test(r.agent)) {
    errors.push("agent must be a valid address");
  }
  if (typeof r.ts !== "string" || Number.isNaN(Date.parse(r.ts))) {
    errors.push("ts must be an ISO timestamp");
  }
  if (typeof r.recorded !== "string" || Number.isNaN(Date.parse(r.recorded))) {
    errors.push("recorded must be an ISO timestamp");
  }
  if (typeof r.action !== "string" || !ACTION_RE.test(r.action)) {
    errors.push("action must be 1-64 chars of [a-z0-9._-]");
  }
  if (typeof r.status !== "string" || !(RECEIPT_STATUSES as readonly string[]).includes(r.status)) {
    errors.push(`status must be one of ${RECEIPT_STATUSES.join("|")}`);
  }
  if (r.durationMs !== undefined && !isNonNegativeNumber(r.durationMs)) {
    errors.push("durationMs must be a non-negative number");
  }
  if (r.tokens !== undefined && (typeof r.tokens !== "object" || r.tokens === null)) {
    errors.push("tokens must be an object");
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeAction(action: string | undefined): string {
  const trimmed = (action ?? "").trim().toLowerCase();
  return trimmed || "other";
}

export function buildReceipt(
  payload: ReceiptPayload,
  defaults: { agent: string; sourceId?: string; now?: Date }
): AuditReceiptV1 {
  const now = (defaults.now ?? new Date()).toISOString();
  const receipt: AuditReceiptV1 = {
    schema: RECEIPT_SCHEMA,
    id: newId("rcp"),
    seq: -1, // claimed from the ledger immediately before append
    agent: defaults.agent,
    ts: typeof payload.ts === "string" ? new Date(payload.ts).toISOString() : now,
    recorded: now,
    action: normalizeAction(payload.action),
    status:
      payload.status && (RECEIPT_STATUSES as readonly string[]).includes(payload.status)
        ? (payload.status as ReceiptStatus)
        : "ok",
  };
  if (payload.provider !== undefined) receipt.provider = payload.provider;
  if (payload.model !== undefined) receipt.model = payload.model;
  if (payload.durationMs !== undefined) receipt.durationMs = payload.durationMs;
  if (payload.tokens !== undefined && typeof payload.tokens === "object" && payload.tokens !== null) {
    const tokens: ReceiptTokens = {};
    if (isNonNegativeNumber(payload.tokens.input)) tokens.input = payload.tokens.input;
    if (isNonNegativeNumber(payload.tokens.output)) tokens.output = payload.tokens.output;
    if (tokens.input !== undefined || tokens.output !== undefined) receipt.tokens = tokens;
  }
  if (payload.subject !== undefined) receipt.subject = payload.subject;
  if (payload.summary !== undefined) receipt.summary = payload.summary;
  if (defaults.sourceId !== undefined) receipt.sourceId = defaults.sourceId;
  if (payload.detail !== undefined) receipt.detail = payload.detail;
  return receipt;
}

/**
 * Short human-readable body for a ledger block. Kept free of comment tokens
 * so a rendered body can never swallow the block's closing marker.
 */
export function renderReceipt(r: AuditReceiptV1): string {
  const clean = (s: string): string => s.replace(/-->/g, "--\\u003e").replace(/<!--/g, "\\u003c!--");
  const bits: string[] = [`**${clean(r.action)}**`, clean(r.status)];
  if (r.model) {
    bits.push(r.provider ? `\`${clean(r.model)}\` via \`${clean(r.provider)}\`` : `\`${clean(r.model)}\``);
  }
  if (typeof r.durationMs === "number") bits.push(`${Math.round(r.durationMs)}ms`);
  if (r.tokens && (r.tokens.input !== undefined || r.tokens.output !== undefined)) {
    bits.push(`${r.tokens.input ?? "?"} in / ${r.tokens.output ?? "?"} out`);
  }
  const lines = [bits.join(" · ")];
  if (r.subject) lines.push(`Subject: \`${clean(r.subject)}\``);
  if (r.summary) lines.push("", clean(r.summary));
  return lines.join("\n");
}
