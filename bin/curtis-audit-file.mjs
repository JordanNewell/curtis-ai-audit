#!/usr/bin/env node
/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */
/**
 * curtis-audit-file.mjs — receipt writer for agent hooks (INTEGRATION.md Path C).
 *
 * Agent hook systems (Claude Code hooks, Codex notify, OpenCode plugins) call
 * this script with their event payload on stdin; it appends one OM-1 message
 * block to the audit inbox, which the curtis-ai-audit plugin polls and ingests.
 *
 * Contract (never break the agent's run):
 *   - Exits 0 on operational failure (disk full, bad inbox path): diagnostics
 *     go to stderr, one line. Exits 2 on usage errors — your own flag typos
 *     or a payload violating the field contract — instead of filing a bad
 *     receipt.
 *   - Appends in a single write; never edits existing inbox content.
 *   - PRIVACY: only path-like fields may appear in the receipt. Command text,
 *     prompt text, note contents, and all other input values are dropped here.
 *
 * Usage:
 *   node curtis-audit-file.mjs --agent <name> [--inbox <path>] [--action <action>]
 *                              [--status <ok|error|aborted>] [--model <id>]
 *                              [--provider <name>] [--tokens <json>]
 * Payload: one JSON object on stdin. Codex `notify` passes JSON as an argv
 * argument instead — that is accepted as a fallback when stdin is empty.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "messenger";
const STATUSES = new Set(["ok", "error", "aborted"]);
const PATH_FIELDS = [
  "file_path",
  "path",
  "notebook_path",
  "glob",
  "url",
];

class UsageError extends Error {}

/** Sorted-key, single-line JSON — mirrors src/protocol.ts canonicalJson. */
export function canonicalJson(value, seen = new Set()) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      if (typeof value !== "object") throw new Error("canonicalJson: unsupported value");
      break;
  }
  if (seen.has(value)) throw new Error("canonicalJson: circular structure");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item === undefined ? null : item, seen)).join(",")}]`;
    }
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Comment tokens inside the envelope would terminate the HTML comment early. */
export function escapeComment(json) {
  return json.replace(/-->/g, "--\\u003e").replace(/<!--/g, "\\u003c!--");
}

export function newId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function buildEnvelope({ from, ts, id }) {
  return escapeComment(
    canonicalJson({ id, from, to: "audit", ts, replyTo: null })
  );
}

const ACTION_RE = /^[a-z0-9._-]+$/;

function cleanAction(value, fallback) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned && cleaned.length <= 64 && ACTION_RE.test(cleaned) ? cleaned : fallback;
}

function cleanOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Tokens are the point of a receipt: invalid ones are a usage error, never a
 * silent drop. `null` means "unknown" (some hook senders emit it), not garbage
 * — it is treated as absent. */
function validateTokens(value, label) {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${label} must be a JSON object of non-negative numbers, e.g. '{"input":1234,"output":567}'`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      throw new UsageError(`${label}.${key} must be a non-negative number`);
    }
  }
  return value;
}

function parseTokensJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`--tokens must be JSON, e.g. '{"input":1234,"output":567}'`);
  }
  return validateTokens(parsed, "--tokens");
}

function firstPathLike(payload) {
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  for (const source of [toolInput, payload]) {
    for (const field of PATH_FIELDS) {
      const value = source[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/**
 * Payload → audit.v1 fields. Hard privacy rule: the only values read from the
 * payload are tool_name, status, model, provider, tokens, and the path-like
 * fields above. Explicit CLI overrides win; tokens from either source are
 * validated (a usage error, never a silent drop).
 */
export function mapPayload(payload, overrides = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const action = cleanAction(overrides.action, cleanAction(p.action, "tool-call"));
  const status = STATUSES.has(overrides.status) ? overrides.status : STATUSES.has(p.status) ? p.status : "ok";
  const subject = firstPathLike(p);
  const model = cleanOptionalString(overrides.model) ?? cleanOptionalString(p.model);
  const provider = cleanOptionalString(overrides.provider) ?? cleanOptionalString(p.provider);
  const tokens = overrides.tokens ?? (p.tokens !== undefined ? validateTokens(p.tokens, "payload tokens") : undefined);
  const toolName = typeof p.tool_name === "string" && p.tool_name.trim() ? p.tool_name.trim() : undefined;
  // A sender-supplied summary is honored only when nothing structural was
  // derived — hook tool_input never reaches the ledger by any other route.
  const senderSummary = typeof p.summary === "string" && p.summary.trim() ? p.summary.trim() : undefined;
  const summary =
    overrides.summary ??
    (toolName && subject
      ? `${toolName} on ${subject}`
      : toolName
        ? toolName
        : subject
          ? `${action} on ${subject}`
          : senderSummary
            ? senderSummary
            : typeof p.type === "string" && p.type.trim()
              ? p.type.trim()
              : typeof p.hook_event_name === "string" && p.hook_event_name.trim()
                ? p.hook_event_name.trim()
                : "agent tool call");
  return { action, status, subject, model, provider, tokens, summary };
}

export function buildBlock({ from, ts, id }, payload, overrides = {}) {
  const fields = mapPayload(payload, overrides);
  // same escaping as the envelope (mirrors src/protocol.ts encodeBlock): a
  // sender-supplied summary/subject containing `-->` or `<!-- /messenger -->`
  // would otherwise terminate the block early and the plugin would reject
  // the receipt. JSON unicode escapes parse back to the original value.
  const body = escapeComment(canonicalJson(fields));
  const json = buildEnvelope({ from, ts, id });
  return `<!-- ${MARKER}: ${json} -->\n${body}\n<!-- /${MARKER} -->\n\n`;
}

// Flags whose value must be present: silently dropping one produces a thin
// receipt (or an unknown-agent one), which is exactly the bug class this
// writer must not have. action/status take fallbacks and are validated later.
const REQUIRED_VALUE_ARGS = new Set(["agent", "inbox", "model", "provider", "tokens"]);
const KNOWN_ARGS = new Set([...REQUIRED_VALUE_ARGS, "action", "status"]);

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!KNOWN_ARGS.has(key)) {
      throw new UsageError(`unknown option --${key} (known: ${[...KNOWN_ARGS].map((k) => `--${k}`).join(", ")})`);
    }
    if (eq >= 0) {
      args[key] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value === "" || value.trim() === "" || value.startsWith("--")) {
      if (REQUIRED_VALUE_ARGS.has(key)) {
        throw new UsageError(`--${key} requires a value`);
      }
      args[key] = ""; // action/status keep their fallbacks
      continue;
    }
    args[key] = value;
    i++; // consume the value so it is not rescanned as a flag
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const done = () => resolve(data);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    // A hook that keeps stdin open must not hang the agent's turn.
    setTimeout(done, 5000).unref();
  });
}

/** Codex notify passes the payload as an argv JSON string; accept it as fallback. */
function argvJson(argv) {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i]?.trim();
    if (arg && arg.startsWith("{") && arg.endsWith("}")) {
      try {
        const parsed = JSON.parse(arg);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // not JSON — keep scanning
      }
    }
  }
  return undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = (await readStdin()).trim();
  let payload = raw ? (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  })() : undefined;
  if (!payload) payload = argvJson(process.argv.slice(2)) ?? {};

  const agent = (args.agent || "").trim() || "unknown-agent";
  const inbox = args.inbox || path.join(process.cwd(), "Messenger", "audit", "inbox.md");
  // An explicit --status outside the vocabulary is a mistake, not a preference:
  // fail loudly rather than filing the receipt under a different status.
  if (args.status !== undefined && !STATUSES.has(args.status)) {
    throw new UsageError(
      `--status must be one of ${[...STATUSES].join("|")} (got ${JSON.stringify(args.status)})`
    );
  }
  // The action vocabulary is intentionally open-ended post-sanitize, so a
  // non-canonical --action is only worth a warning, not a failure.
  let actionOverride;
  if (args.action !== undefined) {
    actionOverride = cleanAction(args.action, "");
    if (actionOverride !== args.action) {
      console.error(
        `[curtis-audit-file] warning: --action ${JSON.stringify(args.action)} sanitized to ${JSON.stringify(actionOverride || "tool-call")}`
      );
    }
  }
  const overrides = {
    action: actionOverride || undefined,
    status: args.status || undefined,
    model: args.model,
    provider: args.provider,
    tokens: args.tokens !== undefined ? parseTokensJson(args.tokens) : undefined,
  };
  const block = buildBlock({ from: agent, ts: new Date().toISOString(), id: newId() }, payload, overrides);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.appendFileSync(inbox, block);
}

/**
 * Whether this module was launched as the entry script. The naive
 * `pathToFileURL(argv[1]) === import.meta.url` check silently fails on
 * Windows (drive-letter case, symlink/realpath), leaving main() unrun and
 * the receipt dropped with exit 0 — compare case-insensitively there, and
 * fall back to resolved realpaths when both paths exist.
 */
export function isDirectInvocation(argv1, moduleUrl) {
  if (!argv1) return false;
  let entry;
  try {
    entry = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const ci = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  let a;
  let b;
  try {
    a = ci(path.resolve(argv1));
    b = ci(path.resolve(entry));
  } catch {
    return false;
  }
  if (a === b) return true;
  try {
    return ci(fs.realpathSync(path.resolve(argv1))) === ci(fs.realpathSync(path.resolve(entry)));
  } catch {
    return false;
  }
}

// Only run the CLI when executed directly, so tests can import the functions.
const invoked = isDirectInvocation(process.argv[1], import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(`[curtis-audit-file] ${err instanceof Error ? err.message : String(err)}`);
    // usage mistakes should be loud (non-zero); operational failures keep the
    // never-break-the-agent contract of exit 0
    process.exitCode = err instanceof UsageError ? 2 : 0;
  });
}
