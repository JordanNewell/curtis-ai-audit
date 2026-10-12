/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

/**
 * OM-1 wire format, vendored from obsidian-messenger's envelope.ts so the two
 * plugins stay byte-compatible (SPEC.md §2–§3 in both repos).
 *
 * Two block kinds share one envelope shape:
 *  - `messenger:` — the bus inbox format. The audit inbox is a normal OM-1
 *    inbox, so anything that can append to a file can submit receipts.
 *  - `curtis-audit:` — ledger blocks. The envelope is the canonical-JSON
 *    receipt; the body is a short human-readable rendering.
 */

export const ADDRESS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface MailEnvelope {
  id: string;
  from: string;
  to: string;
  /** ISO 8601 UTC */
  ts: string;
  replyTo: string | null;
  body: string;
}

export interface ParsedBlock {
  header: Record<string, unknown>;
  body: string;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Sorted-key, single-line JSON. Stable input for any future hash chaining. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new Error("canonicalJson: bigint is not serializable");
    case "object":
      break;
    default:
      throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("canonicalJson: circular structure");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => canonicalize(item === undefined ? null : item, seen));
      return `[${items.join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const item = obj[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalize(item, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * The envelope lives inside an HTML comment, so comment tokens in string
 * values would terminate it early. The escapes are JSON unicode escapes,
 * meaning JSON.parse returns the original value unchanged.
 */
const escapeComment = (json: string): string =>
  json.replace(/-->/g, "--\\u003e").replace(/<!--/g, "\\u003c!--");

export function encodeBlock(marker: string, header: object, body: string): string {
  const json = escapeComment(canonicalJson(header));
  const trimmed = body.replace(/\s+$/, "");
  return `<!-- ${marker}: ${json} -->\n${trimmed}\n<!-- /${marker} -->\n\n`;
}

function markerBlockSource(marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    `<!--\\s*${escaped}:\\s*(\\{[^\\r\\n]*\\})\\s*-->\\r?\\n` +
    `([\\s\\S]*?)<!--\\s*\\/${escaped}\\s*-->`
  );
}

export function parseBlocks(content: string, marker: string): ParsedBlock[] {
  const out: ParsedBlock[] = [];
  const re = new RegExp(markerBlockSource(marker), "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    try {
      const header = JSON.parse(match[1]) as unknown;
      if (typeof header === "object" && header !== null && !Array.isArray(header)) {
        out.push({ header: header as Record<string, unknown>, body: match[2].replace(/\s+$/, "") });
      }
    } catch {
      // malformed block — skip it, never break the whole file
    }
  }
  return out;
}

export function parseInbox(content: string): MailEnvelope[] {
  const out: MailEnvelope[] = [];
  for (const block of parseBlocks(content, "messenger")) {
    const h = block.header;
    if (
      typeof h.id === "string" &&
      typeof h.from === "string" &&
      typeof h.to === "string" &&
      typeof h.ts === "string"
    ) {
      out.push({
        id: h.id,
        from: h.from,
        to: h.to,
        ts: h.ts,
        replyTo: typeof h.replyTo === "string" ? h.replyTo : null,
        body: block.body,
      });
    }
  }
  return out;
}
