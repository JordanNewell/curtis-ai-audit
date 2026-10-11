#!/usr/bin/env node
/**
 * sessions-to-inbox.mjs — dev utility: file one "session" receipt per session
 * markdown file in a vault, so a real corpus can be pushed through ingest.
 *
 * Reads ONLY metadata from each file: the first heading (as the summary) and
 * the file mtime. Note contents never enter the receipts. Output goes where
 * --out says; never writes inside the vault unless explicitly pointed there.
 *
 * Usage:
 *   node bin/sessions-to-inbox.mjs --root <vault-dir> --out <inbox.md> \
 *        [--agent claude-code] [--max 500] [--max-bytes 2000000] [--match session|handoff]
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, escapeComment, newId } from "./curtis-audit-file.mjs";

const SKIP_DIRS = new Set([".obsidian", ".stversions", ".claude", ".git", "node_modules", ".trash"]);

function walk(dir, base, match, out, budget) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, base, match, out, budget);
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (!match.test(rel)) continue;
    const size = entry.isFile() ? fs.statSync(full).size : 0;
    if (size > budget.maxBytes) {
      budget.skipped.push(rel);
      continue;
    }
    out.push(rel);
    budget.left--;
  }
}

/** First heading or first non-empty line, markdown stripped, one line max. */
function titleOf(content) {
  const lines = content.split(/\r?\n/);
  // Skip a YAML frontmatter block if present — its `title:` line is not prose.
  if (lines[0]?.trim() === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) lines.splice(0, close + 1);
  }
  let heading = null;
  let first = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue;
    if (heading === null && trimmed.startsWith("#")) {
      heading = trimmed.replace(/^#+\s*/, "");
      continue;
    }
    first = trimmed;
    break;
  }
  const picked = (heading ?? first ?? "untitled session note")
    .replace(/\*\*|__|`|\[|\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return picked || "untitled session note";
}

/** Stable per-file message id: same file → same id → re-ingest dedupes. */
function stableId(rel) {
  let h = 5381;
  for (let i = 0; i < rel.length; i++) h = ((h << 5) + h + rel.charCodeAt(i)) >>> 0;
  return `msg_${h.toString(36)}${rel.length.toString(36)}`;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
  };
  const root = arg("root");
  const out = arg("out");
  if (!root || !out) {
    console.error("usage: sessions-to-inbox.mjs --root <dir> --out <inbox.md> [--agent a] [--max n] [--max-bytes n] [--match re]");
    process.exit(1);
  }
  const agent = arg("agent", "claude-code");
  const max = parseInt(arg("max", "500"), 10);
  const maxBytes = parseInt(arg("max-bytes", "2000000"), 10);
  const match = new RegExp(arg("match", "session|handoff"), "i");
  const base = path.resolve(root);

  const found = [];
  const budget = { left: max, maxBytes, skipped: [] };
  walk(base, base, match, found, budget);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  let written = 0;
  for (const rel of found) {
    const full = path.join(base, rel);
    let content = "";
    let mtime;
    try {
      content = fs.readFileSync(full, "utf8");
      mtime = fs.statSync(full).mtime;
    } catch (err) {
      budget.skipped.push(`${rel} (${err.code})`);
      continue;
    }
    const payload = {
      action: "session",
      status: "ok",
      subject: rel,
      summary: titleOf(content),
      ts: mtime.toISOString(),
    };
    const body = canonicalJson(payload);
    const envelope = escapeComment(
      canonicalJson({ id: stableId(rel), from: agent, to: "audit", ts: new Date().toISOString(), replyTo: null })
    );
    const block = `<!-- messenger: ${envelope} -->\n${body}\n<!-- /messenger -->\n\n`;
    fs.appendFileSync(out, block); // one atomic append per receipt
    written++;
  }

  console.log(
    `[sessions-to-inbox] agent=${agent} matched=${found.length} written=${written} ` +
      `skipped=${budget.skipped.length} out=${path.resolve(out)}`
  );
  if (budget.skipped.length) console.log(`[sessions-to-inbox] skipped: ${budget.skipped.join(", ")}`);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (invoked) main();
