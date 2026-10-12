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
 *   - ALWAYS exits 0, even on failure; diagnostics go to stderr, one line.
 *   - Appends in a single write; never edits existing inbox content.
 *   - PRIVACY: only path-like fields may appear in the receipt. Command text,
 *     prompt text, note contents, and all other input values are dropped here.
 *
 * Usage:
 *   node curtis-audit-file.mjs --agent <name> [--inbox <path>] [--action <action>]
 *                              [--status <ok|error|aborted>]
 * Payload: one JSON object on stdin. Codex `notify` passes JSON as an argv
 * argument instead — that is accepted as a fallback when stdin is empty.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MARKER = "messenger";
const STATUSES = new Set(["ok", "error", "aborted"]);
const PATH_FIELDS = [
  "file_path",
  "path",
  "notebook_path",
  "glob",
  "url",
];

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
 * payload are tool_name, status, and the path-like fields above.
 */
export function mapPayload(payload, overrides = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  const action = cleanAction(overrides.action, cleanAction(p.action, "tool-call"));
  const status = STATUSES.has(overrides.status) ? overrides.status : STATUSES.has(p.status) ? p.status : "ok";
  const subject = firstPathLike(p);
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
  return { action, status, subject, summary };
}

export function buildBlock({ from, ts, id }, payload, overrides = {}) {
  const fields = mapPayload(payload, overrides);
  const body = canonicalJson(fields);
  const json = buildEnvelope({ from, ts, id });
  return `<!-- ${MARKER}: ${json} -->\n${body}\n<!-- /${MARKER} -->\n\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) args[arg.slice(2)] = argv[i + 1] ?? "";
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
  const overrides = {
    action: args.action || undefined,
    status: args.status || undefined,
  };
  const block = buildBlock({ from: agent, ts: new Date().toISOString(), id: newId() }, payload, overrides);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.appendFileSync(inbox, block);
}

// Only run the CLI when executed directly, so tests can import the functions.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (invoked) {
  main().catch((err) => {
    console.error(`[curtis-audit-file] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
}
