/*
Curtis AI Audit — local-first audit trail for AI agent activity.
Every agent inference gets an append-only markdown receipt in the vault.
Speaks OM-1 (Obsidian Messenger protocol). See SPEC.md.
*/

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  buildDigest: () => buildDigest,
  default: () => CurtisAuditPlugin,
  verifyLedger: () => verifyLedger
});
module.exports = __toCommonJS(main_exports);
var import_obsidian5 = require("obsidian");

// src/icon.ts
var CURTIS_MARK_ICON_ID = "curtis-ai-mark";
var CURTIS_MARK_SVG = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="#0E7A45" d="M 855.3 275.1 A 417.5 417.5 0 1 0 855.3 747.9 C 872.6 707.8 869.8 676.9 770 630.3 A 284.5 284.5 0 1 1 770 392.7 C 869.8 346.1 872.6 315.2 855.3 275.1 Z"/><path d="M 690 515.7 L 737.5 563 L 831 462" fill="none" stroke="#0E7A45" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// src/ledger.ts
var import_obsidian2 = require("obsidian");

// src/registry.ts
var import_obsidian = require("obsidian");

// src/protocol.ts
var ADDRESS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function canonicalJson(value) {
  return canonicalize(value, /* @__PURE__ */ new Set());
}
function canonicalize(value, seen) {
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
      const items = value.map((item) => canonicalize(item === void 0 ? null : item, seen));
      return `[${items.join(",")}]`;
    }
    const obj = value;
    const parts = [];
    for (const key of Object.keys(obj).sort()) {
      const item = obj[key];
      if (item === void 0) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalize(item, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
var escapeComment = (json) => json.replace(/-->/g, "--\\u003e").replace(/<!--/g, "\\u003c!--");
function encodeBlock(marker, header, body) {
  const json = escapeComment(canonicalJson(header));
  const trimmed = body.replace(/\s+$/, "");
  return `<!-- ${marker}: ${json} -->
${trimmed}
<!-- /${marker} -->

`;
}
function markerBlockSource(marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `<!--\\s*${escaped}:\\s*(\\{[^\\r\\n]*\\})\\s*-->\\r?\\n([\\s\\S]*?)<!--\\s*\\/${escaped}\\s*-->`;
}
function parseBlocks(content, marker) {
  const out = [];
  const re = new RegExp(markerBlockSource(marker), "g");
  let match;
  while ((match = re.exec(content)) !== null) {
    try {
      const header = JSON.parse(match[1]);
      if (typeof header === "object" && header !== null && !Array.isArray(header)) {
        out.push({ header, body: match[2].replace(/\s+$/, "") });
      }
    } catch (e) {
    }
  }
  return out;
}
function parseInbox(content) {
  const out = [];
  for (const block of parseBlocks(content, "messenger")) {
    const h = block.header;
    if (typeof h.id === "string" && typeof h.from === "string" && typeof h.to === "string" && typeof h.ts === "string") {
      out.push({
        id: h.id,
        from: h.from,
        to: h.to,
        ts: h.ts,
        replyTo: typeof h.replyTo === "string" ? h.replyTo : null,
        body: block.body
      });
    }
  }
  return out;
}

// src/registry.ts
async function ensureFolder(vault, relPath) {
  const path = (0, import_obsidian.normalizePath)(relPath);
  if (!path) return;
  if (vault.getAbstractFileByPath(path) instanceof import_obsidian.TFolder) return;
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (vault.getAbstractFileByPath(current) instanceof import_obsidian.TFolder) continue;
    try {
      await vault.createFolder(current);
    } catch (e) {
    }
  }
}
async function writeFile(vault, path, content) {
  const normalized = (0, import_obsidian.normalizePath)(path);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  await ensureFolder(vault, parts.join("/"));
  const file = vault.getAbstractFileByPath(normalized);
  if (file instanceof import_obsidian.TFile) {
    await vault.modify(file, content);
    return;
  }
  try {
    await vault.create(normalized, content);
  } catch (e) {
    const existing = vault.getAbstractFileByPath(normalized);
    if (existing instanceof import_obsidian.TFile) await vault.modify(existing, content);
  }
}
async function mutateFileAtomic(vault, path, mutate) {
  const file = vault.getAbstractFileByPath((0, import_obsidian.normalizePath)(path));
  if (!(file instanceof import_obsidian.TFile)) throw new Error(`mutateFileAtomic: no file at ${path}`);
  const withProcess = vault;
  if (typeof withProcess.process === "function") {
    await withProcess.process(file.path, mutate);
    return;
  }
  await vault.modify(file, mutate(await vault.read(file)));
}
function inboxHeader(address) {
  return `# Inbox \u2014 ${address}

Append-only, oldest at top. Do not reorder or edit delivered blocks. See SPEC.md.

`;
}
async function upsertRegistryEntry(vault, root, entry) {
  if (!ADDRESS_RE.test(entry.address)) {
    throw new Error(`Invalid messenger address: ${entry.address}`);
  }
  const registryPath = (0, import_obsidian.normalizePath)(`${root}/registry.md`);
  const entries = await readRegistry(vault, root);
  const next = [entry, ...entries.filter((e) => e.address !== entry.address)].sort(
    (a, b) => a.address.localeCompare(b.address)
  );
  const escape = (s) => s.replace(/\|/g, "\\|");
  const table = "| address | name | updated |\n| --- | --- | --- |\n" + next.map((e) => `| ${escape(e.address)} | ${escape(e.name)} | ${escape(e.updated)} |`).join("\n") + "\n";
  const content = `# Messenger registry

Who lives on this bus. Advisory only \u2014 any folder with an inbox.md is addressable. Rewritten by plugins, not appended.

${table}`;
  await writeFile(vault, registryPath, content);
}
async function readRegistry(vault, root) {
  const registryPath = (0, import_obsidian.normalizePath)(`${root}/registry.md`);
  const file = vault.getAbstractFileByPath(registryPath);
  if (!(file instanceof import_obsidian.TFile)) return [];
  const content = await vault.read(file);
  const entries = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    if (cells.length < 5) continue;
    const address = cells[1];
    const name = cells[2];
    const updated = cells[3];
    if (!address || address === "---" || !ADDRESS_RE.test(address)) continue;
    entries.push({
      address,
      name: (name || address).replace(/\\\|/g, "|"),
      updated: updated.replace(/\\\|/g, "|")
    });
  }
  return entries;
}

// src/schema.ts
var RECEIPT_SCHEMA = "audit.v1";
var RECEIPT_STATUSES = ["ok", "error", "aborted"];
var ACTION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var isNonNegativeNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function validatePayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ["payload must be a JSON object"] };
  }
  const p = payload;
  const errors = [];
  if (p.agent !== void 0 && (typeof p.agent !== "string" || !ADDRESS_RE.test(p.agent))) {
    errors.push(`invalid agent address: ${String(p.agent)}`);
  }
  if (p.ts !== void 0 && (typeof p.ts !== "string" || Number.isNaN(Date.parse(p.ts)))) {
    errors.push(`invalid ts: ${String(p.ts)}`);
  }
  if (p.status !== void 0 && !RECEIPT_STATUSES.includes(p.status)) {
    errors.push(`status must be one of ${RECEIPT_STATUSES.join("|")}`);
  }
  if (p.action !== void 0 && (typeof p.action !== "string" || !ACTION_RE.test(normalizeAction(p.action)))) {
    errors.push(`invalid action: ${String(p.action)}`);
  }
  if (p.durationMs !== void 0 && !isNonNegativeNumber(p.durationMs)) {
    errors.push("durationMs must be a non-negative number");
  }
  if (p.tokens !== void 0) {
    if (typeof p.tokens !== "object" || p.tokens === null) {
      errors.push("tokens must be an object");
    } else {
      const t = p.tokens;
      for (const key of ["input", "output"]) {
        if (t[key] !== void 0 && !isNonNegativeNumber(t[key])) {
          errors.push(`tokens.${key} must be a non-negative number`);
        }
      }
    }
  }
  try {
    JSON.stringify(payload);
  } catch (err) {
    errors.push(`payload is not JSON-serializable: ${err.message}`);
  }
  return { ok: errors.length === 0, errors };
}
function validateReceipt(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["receipt must be a JSON object"] };
  }
  const r = value;
  const errors = [];
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
  if (typeof r.status !== "string" || !RECEIPT_STATUSES.includes(r.status)) {
    errors.push(`status must be one of ${RECEIPT_STATUSES.join("|")}`);
  }
  if (r.durationMs !== void 0 && !isNonNegativeNumber(r.durationMs)) {
    errors.push("durationMs must be a non-negative number");
  }
  if (r.tokens !== void 0 && (typeof r.tokens !== "object" || r.tokens === null)) {
    errors.push("tokens must be an object");
  }
  return { ok: errors.length === 0, errors };
}
function normalizeAction(action) {
  const trimmed = (action != null ? action : "").trim().toLowerCase();
  return trimmed || "other";
}
function buildReceipt(payload, defaults) {
  var _a;
  const now = ((_a = defaults.now) != null ? _a : /* @__PURE__ */ new Date()).toISOString();
  const receipt = {
    schema: RECEIPT_SCHEMA,
    id: newId("rcp"),
    seq: -1,
    // claimed from the ledger immediately before append
    agent: defaults.agent,
    ts: typeof payload.ts === "string" ? new Date(payload.ts).toISOString() : now,
    recorded: now,
    action: normalizeAction(payload.action),
    status: payload.status && RECEIPT_STATUSES.includes(payload.status) ? payload.status : "ok"
  };
  if (payload.provider !== void 0) receipt.provider = payload.provider;
  if (payload.model !== void 0) receipt.model = payload.model;
  if (payload.durationMs !== void 0) receipt.durationMs = payload.durationMs;
  if (payload.tokens !== void 0 && typeof payload.tokens === "object" && payload.tokens !== null) {
    const tokens = {};
    if (isNonNegativeNumber(payload.tokens.input)) tokens.input = payload.tokens.input;
    if (isNonNegativeNumber(payload.tokens.output)) tokens.output = payload.tokens.output;
    if (tokens.input !== void 0 || tokens.output !== void 0) receipt.tokens = tokens;
  }
  if (payload.subject !== void 0) receipt.subject = payload.subject;
  if (payload.summary !== void 0) receipt.summary = payload.summary;
  if (defaults.sourceId !== void 0) receipt.sourceId = defaults.sourceId;
  if (payload.detail !== void 0) receipt.detail = payload.detail;
  return receipt;
}
function renderReceipt(r) {
  var _a, _b;
  const clean = (s) => s.replace(/-->/g, "--\\u003e").replace(/<!--/g, "\\u003c!--");
  const bits = [`**${clean(r.action)}**`, clean(r.status)];
  if (r.model) {
    bits.push(r.provider ? `\`${clean(r.model)}\` via \`${clean(r.provider)}\`` : `\`${clean(r.model)}\``);
  }
  if (typeof r.durationMs === "number") bits.push(`${Math.round(r.durationMs)}ms`);
  if (r.tokens && (r.tokens.input !== void 0 || r.tokens.output !== void 0)) {
    bits.push(`${(_a = r.tokens.input) != null ? _a : "?"} in / ${(_b = r.tokens.output) != null ? _b : "?"} out`);
  }
  const lines = [bits.join(" \xB7 ")];
  if (r.subject) lines.push(`Subject: \`${clean(r.subject)}\``);
  if (r.summary) lines.push("", clean(r.summary));
  return lines.join("\n");
}

// src/ledger.ts
var LEDGER_MARKER = "curtis-audit";
var SHARD_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
function shardHeader(day) {
  return `# Audit ledger \u2014 ${day}

Append-only receipts, oldest first. Envelopes are canonical JSON (audit.v1); bodies are human summaries. Do not reorder or edit blocks. See SPEC.md.

`;
}
var AuditLedger = class {
  constructor(vault, root) {
    this.vault = vault;
    this.root = root;
    this.seqByAgent = /* @__PURE__ */ new Map();
    this.stateLoaded = false;
    this.stateDirty = false;
  }
  get ledgerDir() {
    return (0, import_obsidian2.normalizePath)(`${this.root}/ledger`);
  }
  get statePath() {
    return (0, import_obsidian2.normalizePath)(`${this.root}/state.json`);
  }
  shardPath(day) {
    return (0, import_obsidian2.normalizePath)(`${this.root}/ledger/${day}.md`);
  }
  async ensureDirs() {
    await ensureFolder(this.vault, `${this.root}/ledger`);
  }
  /** Reserve the next sequence number for an agent (monotonic, per agent). */
  async claimSeq(agent) {
    var _a;
    await this.ensureStateLoaded();
    const next = ((_a = this.seqByAgent.get(agent)) != null ? _a : -1) + 1;
    this.seqByAgent.set(agent, next);
    this.stateDirty = true;
    return next;
  }
  /** Write a receipt to the shard for its `recorded` day. Append-only. */
  async append(receipt) {
    if (!Number.isInteger(receipt.seq) || receipt.seq < 0) {
      throw new Error("receipt.seq must be claimed via claimSeq() before append");
    }
    const day = receipt.recorded.slice(0, 10);
    const path = this.shardPath(day);
    const block = encodeBlock(
      LEDGER_MARKER,
      receipt,
      renderReceipt(receipt)
    );
    const file = this.vault.getAbstractFileByPath(path);
    if (file instanceof import_obsidian2.TFile) {
      await mutateFileAtomic(this.vault, path, (content) => content.replace(/\s+$/, "\n\n") + block);
      return;
    }
    try {
      await this.vault.create(path, shardHeader(day) + block);
    } catch (e) {
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof import_obsidian2.TFile) {
        await mutateFileAtomic(this.vault, path, (content) => content.replace(/\s+$/, "\n\n") + block);
      }
    }
  }
  async saveState() {
    if (!this.stateDirty) return;
    const agents = {};
    for (const [agent, lastSeq] of this.seqByAgent) agents[agent] = { lastSeq };
    const state = {
      version: 1,
      agents,
      updated: (/* @__PURE__ */ new Date()).toISOString()
    };
    await writeFile(this.vault, this.statePath, canonicalJson(state) + "\n");
    this.stateDirty = false;
  }
  /** Day-file paths, sorted oldest first. */
  listShards() {
    const dir = this.vault.getAbstractFileByPath(this.ledgerDir);
    if (!(dir instanceof import_obsidian2.TFolder)) return [];
    return dir.children.filter((child) => child instanceof import_obsidian2.TFile && SHARD_RE.test(child.name)).map((f) => f.path).sort();
  }
  async readShard(path) {
    const out = { receipts: [], blocks: 0, malformed: 0 };
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof import_obsidian2.TFile)) return out;
    const content = await this.vault.read(file);
    const blocks = parseBlocks(content, LEDGER_MARKER);
    out.blocks = blocks.length;
    const openings = content.split(`<!-- ${LEDGER_MARKER}:`).length - 1;
    out.malformed = Math.max(0, openings - out.blocks);
    for (const block of blocks) {
      const check = validateReceipt(block.header);
      if (check.ok) {
        out.receipts.push(block.header);
      } else {
        out.malformed++;
      }
    }
    return out;
  }
  async readAll() {
    const all = [];
    for (const path of this.listShards()) {
      for (const receipt of (await this.readShard(path)).receipts) {
        all.push(receipt);
      }
    }
    return all;
  }
  /**
   * Drop receipts recorded before the cutoff. Unlike mail GC, retention
   * defaults to off (0 = keep everything) — an audit trail that silently
   * ages out is a policy contradiction. Pruning whole shards leaves seq
   * gaps; that trade-off is documented in SPEC.md.
   */
  async prune(maxAgeDays) {
    if (maxAgeDays <= 0) return 0;
    const cutoff = Date.now() - maxAgeDays * 864e5;
    let dropped = 0;
    for (const path of this.listShards()) {
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof import_obsidian2.TFile)) continue;
      const read = await this.readShard(path);
      if (read.blocks === 0) continue;
      const kept = read.receipts.filter((r) => Date.parse(r.recorded) >= cutoff);
      dropped += read.receipts.length - kept.length;
      if (kept.length === 0) {
        await this.vault.delete(file, true);
      } else if (kept.length !== read.receipts.length) {
        const day = file.name.replace(/\.md$/, "");
        const content = shardHeader(day) + kept.map(renderBlock).join("");
        await this.vault.modify(file, content);
      }
    }
    return dropped;
  }
  /** Write (or replace) a companion note such as digest.md. */
  async writeNote(relPath, content) {
    await writeFile(this.vault, relPath, content);
  }
  async ensureStateLoaded() {
    var _a;
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const file = this.vault.getAbstractFileByPath(this.statePath);
    if (file instanceof import_obsidian2.TFile) {
      try {
        const state = JSON.parse(await this.vault.read(file));
        if (state && typeof state === "object" && state.agents && typeof state.agents === "object") {
          for (const agent of Object.keys(state.agents)) {
            const lastSeq = (_a = state.agents[agent]) == null ? void 0 : _a.lastSeq;
            if (typeof lastSeq === "number" && Number.isInteger(lastSeq) && lastSeq >= 0) {
              this.seqByAgent.set(agent, lastSeq);
            }
          }
          return;
        }
      } catch (e) {
      }
    }
    await this.rebuildState();
  }
  /** Scan every shard and recompute per-agent sequence high-water marks. */
  async rebuildState() {
    this.seqByAgent.clear();
    for (const receipt of await this.readAll()) {
      const last = this.seqByAgent.get(receipt.agent);
      if (last === void 0 || receipt.seq > last) this.seqByAgent.set(receipt.agent, receipt.seq);
    }
    this.stateDirty = true;
    await this.saveState();
  }
};
function renderBlock(receipt) {
  return encodeBlock(
    LEDGER_MARKER,
    receipt,
    renderReceipt(receipt)
  );
}

// src/ingest.ts
var import_obsidian3 = require("obsidian");
var AuditIngestor = class {
  constructor(vault, ledger, opts) {
    this.vault = vault;
    this.ledger = ledger;
    this.opts = opts;
    this.cursors = {};
    this.seenSourceIds = /* @__PURE__ */ new Set();
  }
  get inboxPath() {
    return (0, import_obsidian3.normalizePath)(`${this.opts.messengerRoot}/${this.opts.address}/inbox.md`);
  }
  setCursors(cursors) {
    this.cursors = { ...cursors };
  }
  getCursors() {
    return { ...this.cursors };
  }
  /** One poll pass. Advances the in-memory cursor; the caller persists it. */
  async poll() {
    var _a;
    const result = { delivered: 0, receipts: 0, rejected: 0, duplicates: 0 };
    const file = this.vault.getAbstractFileByPath(this.inboxPath);
    if (!(file instanceof import_obsidian3.TFile)) return result;
    const messages = parseInbox(await this.vault.read(file));
    const pending = pendingAfter(messages, (_a = this.cursors[this.inboxPath]) != null ? _a : null);
    for (const message of pending) {
      result.delivered++;
      const outcome = await this.ingestMessage(message);
      if (outcome === "receipt") result.receipts++;
      else if (outcome === "duplicate") result.duplicates++;
      else result.rejected++;
      this.cursors[this.inboxPath] = { id: message.id, ts: message.ts };
    }
    if (result.delivered > 0) await this.ledger.saveState();
    return result;
  }
  async ingestMessage(message) {
    var _a;
    if (this.seenSourceIds.has(message.id)) return "duplicate";
    const body = message.body.trim();
    if (!body.startsWith("{")) return "rejected";
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      return "rejected";
    }
    const check = validatePayload(payload);
    if (!check.ok) return "rejected";
    if (await this.sourceAlreadyIngested(message.id)) return "duplicate";
    const agent = (_a = payload.agent) != null ? _a : message.from;
    const receipt = buildReceipt(payload, { agent, sourceId: message.id });
    receipt.seq = await this.ledger.claimSeq(agent);
    await this.ledger.append(receipt);
    this.seenSourceIds.add(message.id);
    return "receipt";
  }
  /**
   * Best-effort idempotence: check recent shards for this source message id.
   * Only recent shards are checked — this guards the crash window between
   * ledger append and cursor save, not arbitrary replay of ancient mail.
   */
  async sourceAlreadyIngested(sourceId) {
    const shards = this.ledger.listShards().slice(-2);
    for (const path of shards) {
      const read = await this.ledger.readShard(path);
      if (read.receipts.some((r) => r.sourceId === sourceId)) return true;
    }
    return false;
  }
};
function pendingAfter(messages, cursor) {
  if (!cursor) return messages;
  const idx = messages.findIndex((m) => m.id === cursor.id);
  if (idx >= 0) return messages.slice(idx + 1);
  const ts = Date.parse(cursor.ts);
  return messages.filter((m) => Date.parse(m.ts) > ts);
}

// src/verify.ts
var MAX_LISTED = 20;
async function verifyLedger(ledger) {
  var _a, _b;
  const issues = [];
  const shards = ledger.listShards();
  const receipts = [];
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
        message: `${read.malformed} malformed or invalid block(s)`
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
      message: `${reordered} receipt(s) are out of recorded-order within their file \u2014 something edited or merged a ledger shard`
    });
  }
  const byId = /* @__PURE__ */ new Map();
  const byAgentSeq = /* @__PURE__ */ new Map();
  for (const r of receipts) {
    byId.set(r.id, ((_a = byId.get(r.id)) != null ? _a : 0) + 1);
    const key = `${r.agent}#${r.seq}`;
    byAgentSeq.set(key, ((_b = byAgentSeq.get(key)) != null ? _b : 0) + 1);
  }
  for (const [id, n] of byId) {
    if (n > 1) {
      issues.push({
        severity: "error",
        file: "(ledger)",
        message: `receipt id ${id} appears ${n} times`
      });
    }
  }
  for (const [key, n] of byAgentSeq) {
    if (n > 1) {
      issues.push({
        severity: "error",
        file: "(ledger)",
        message: `${key} appears ${n} times (duplicate sequence number)`
      });
    }
  }
  const agents = /* @__PURE__ */ new Map();
  for (const r of receipts) {
    let a = agents.get(r.agent);
    if (!a) {
      a = { count: 0, min: r.seq, max: r.seq, seen: /* @__PURE__ */ new Set() };
      agents.set(r.agent, a);
    }
    a.count++;
    if (r.seq < a.min) a.min = r.seq;
    if (r.seq > a.max) a.max = r.seq;
    a.seen.add(r.seq);
  }
  const agentReports = [];
  const sortedAgents = Array.from(agents.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [agent, a] of sortedAgents) {
    const missing = [];
    for (let s = a.min; s <= a.max; s++) {
      if (!a.seen.has(s)) missing.push(s);
    }
    if (missing.length > 0) {
      const listed = missing.slice(0, MAX_LISTED).join(", ") + (missing.length > MAX_LISTED ? ` \u2026 (+${missing.length - MAX_LISTED} more)` : "");
      issues.push({
        severity: "warning",
        file: "(ledger)",
        message: `${agent}: ${missing.length} missing sequence number(s) between ${a.min} and ${a.max} [${listed}] \u2014 deleted receipts, failed writes, or shards dropped by pruning`
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
    ok: !issues.some((i) => i.severity === "error")
  };
}

// src/digest.ts
function formatDuration(ms) {
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  const seconds = ms / 1e3;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
async function buildDigest(ledger, opts = {}) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
  const days = Math.max(1, Math.floor((_a = opts.days) != null ? _a : 1));
  const now = (_b = opts.now) != null ? _b : /* @__PURE__ */ new Date();
  const cutoff = now.getTime() - days * 864e5;
  const all = [];
  for (const receipt of await ledger.readAll()) {
    if (Date.parse(receipt.recorded) >= cutoff) all.push(receipt);
  }
  const lines = [];
  lines.push("# Audit digest");
  lines.push("");
  lines.push(
    `Period: last ${days} day${days === 1 ? "" : "s"} (through ${now.toISOString()}). Ledger: \`${ledger.ledgerDir}/\`.`
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
    if (typeof ((_c = r.tokens) == null ? void 0 : _c.input) === "number") tokensIn += r.tokens.input;
    if (typeof ((_d = r.tokens) == null ? void 0 : _d.output) === "number") tokensOut += r.tokens.output;
    if (typeof r.durationMs === "number") totalMs += r.durationMs;
  }
  const tokenPart = tokensIn > 0 || tokensOut > 0 ? `, ${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out` : "";
  const durationPart = totalMs > 0 ? `, total duration ${formatDuration(totalMs)}` : "";
  lines.push(
    `**${all.length}** receipts \u2014 ${okCount} ok, ${errCount} error, ${abortCount} aborted${tokenPart}${durationPart}.`
  );
  lines.push("");
  const byDay = /* @__PURE__ */ new Map();
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
  if (byDay.size > 1) {
    lines.push("### By day");
    lines.push("");
    lines.push("| day | receipts | ok | error | aborted |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const day of Array.from(byDay.keys()).sort()) {
      const row = byDay.get(day);
      lines.push(`| ${day} | ${row.total} | ${row.ok} | ${row.error} | ${row.aborted} |`);
    }
    lines.push("");
  }
  const agentRows = /* @__PURE__ */ new Map();
  const actionCounts = /* @__PURE__ */ new Map();
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
    if (typeof ((_e = r.tokens) == null ? void 0 : _e.input) === "number") {
      row.tokensIn = ((_f = row.tokensIn) != null ? _f : 0) + r.tokens.input;
    }
    if (typeof ((_g = r.tokens) == null ? void 0 : _g.output) === "number") {
      row.tokensOut = ((_h = row.tokensOut) != null ? _h : 0) + r.tokens.output;
    }
    actionCounts.set(r.action, ((_i = actionCounts.get(r.action)) != null ? _i : 0) + 1);
  }
  lines.push("| agent | receipts | ok | error | aborted | tokens in | tokens out |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const agent of Array.from(agentRows.keys()).sort()) {
    const row = agentRows.get(agent);
    const tin = row.tokensIn !== void 0 ? row.tokensIn.toLocaleString() : "\u2014";
    const tout = row.tokensOut !== void 0 ? row.tokensOut.toLocaleString() : "\u2014";
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
      const label = (_l = (_k = (_j = r.summary) != null ? _j : r.model) != null ? _k : r.provider) != null ? _l : "";
      lines.push(`- \`${r.id}\` **${r.agent}** ${label} \u2014 ${r.recorded}`);
    }
    lines.push("");
  }
  const latest = all.slice(-10).reverse();
  lines.push("### Latest receipts");
  lines.push("");
  for (const r of latest) {
    const model = r.model ? ` \`${r.model}\`` : "";
    lines.push(`- \`${r.id}\` **${r.action}** ${r.agent}${model} \u2014 ${r.recorded}`);
  }
  return lines.join("\n") + "\n";
}

// src/query.ts
function boundMs(value, label) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`query.${label} must be an ISO timestamp or epoch ms`);
  }
  return ms;
}
function queryReceipts(receipts, query = {}) {
  if (query.order !== void 0 && query.order !== "asc" && query.order !== "desc") {
    throw new Error('query.order must be "asc" or "desc"');
  }
  if (query.limit !== void 0 && (!Number.isInteger(query.limit) || query.limit < 1)) {
    throw new Error("query.limit must be a positive integer");
  }
  if (query.status !== void 0 && !RECEIPT_STATUSES.includes(query.status)) {
    throw new Error(`query.status must be one of ${RECEIPT_STATUSES.join("|")}`);
  }
  const sinceMs = query.since !== void 0 ? boundMs(query.since, "since") : -Infinity;
  const untilMs = query.until !== void 0 ? boundMs(query.until, "until") : Infinity;
  const matched = receipts.filter((r) => {
    var _a;
    if (query.agent !== void 0 && r.agent !== query.agent) return false;
    if (query.action !== void 0 && r.action !== query.action) return false;
    if (query.status !== void 0 && r.status !== query.status) return false;
    if (query.model !== void 0 && r.model !== query.model) return false;
    if (query.subject !== void 0 && !((_a = r.subject) != null ? _a : "").startsWith(query.subject)) return false;
    const ms = Date.parse(r.recorded);
    return ms >= sinceMs && ms <= untilMs;
  });
  matched.sort((a, b) => {
    const byRecorded = Date.parse(a.recorded) - Date.parse(b.recorded);
    if (byRecorded !== 0) return byRecorded;
    return a.seq - b.seq;
  });
  if (query.order !== "asc") matched.reverse();
  if (query.limit !== void 0) matched.length = Math.min(matched.length, query.limit);
  return matched;
}

// src/api.ts
function createApi(ledger, ingestor, hooks = {}) {
  return {
    version: 1,
    async record(payload) {
      var _a;
      const check = validatePayload(payload);
      if (!check.ok) {
        throw new Error(`Invalid audit payload: ${check.errors.join("; ")}`);
      }
      if (!payload.agent) {
        throw new Error("payload.agent is required \u2014 who made this inference?");
      }
      const receipt = buildReceipt(payload, { agent: payload.agent });
      receipt.seq = await ledger.claimSeq(receipt.agent);
      await ledger.append(receipt);
      await ledger.saveState();
      (_a = hooks.onReceipt) == null ? void 0 : _a.call(hooks, receipt);
      return receipt;
    },
    poll: () => ingestor.poll(),
    verify: () => verifyLedger(ledger),
    digest: (days) => buildDigest(ledger, { days: days != null ? days : 1 }),
    query: async (query) => queryReceipts(await ledger.readAll(), query)
  };
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  root: "Audit",
  messengerRoot: "Messenger",
  inboxAddress: "audit",
  pollSeconds: 10,
  retentionDays: 0,
  debug: false,
  cursors: {}
};
function cleanPath(value, fallback) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").trim();
  return cleaned || fallback;
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function sanitizeSettings(raw) {
  const s = raw != null ? raw : {};
  return {
    root: cleanPath(s.root, DEFAULT_SETTINGS.root),
    messengerRoot: typeof s.messengerRoot === "string" ? s.messengerRoot.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").trim() : DEFAULT_SETTINGS.messengerRoot,
    inboxAddress: typeof s.inboxAddress === "string" && ADDRESS_RE.test(s.inboxAddress) ? s.inboxAddress : DEFAULT_SETTINGS.inboxAddress,
    pollSeconds: clamp(Math.floor(Number(s.pollSeconds) || DEFAULT_SETTINGS.pollSeconds), 1, 3600),
    retentionDays: clamp(Math.floor(Number(s.retentionDays) || 0), 0, 36500),
    debug: Boolean(s.debug),
    cursors: s.cursors && typeof s.cursors === "object" ? s.cursors : {}
  };
}

// src/settings-tab.ts
var import_obsidian4 = require("obsidian");

// src/nmoji.ts
var NMOJI_DATA_URI = "data:image/png;base64,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";

// src/settings-tab.ts
var AuditSettingTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const heading = containerEl.createEl("h2");
    (0, import_obsidian4.setIcon)(heading.createSpan({ cls: "curtis-audit-mark" }), CURTIS_MARK_ICON_ID);
    heading.appendText("Curtis AI Audit");
    new import_obsidian4.Setting(containerEl).setName("Ledger folder").setDesc("Receipts are appended under <folder>/ledger/, one markdown shard per day.").addText(
      (text) => text.setValue(this.plugin.settings.root).onChange(async (value) => {
        this.plugin.settings.root = value;
        await this.plugin.saveAndReload();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Messenger root").setDesc(
      "Folder of the OM-1 bus (default Messenger). The audit inbox is watched at <root>/<inbox address>/inbox.md. Clear to disable bus ingest; direct recording via window.curtisAudit keeps working."
    ).addText(
      (text) => text.setValue(this.plugin.settings.messengerRoot).onChange(async (value) => {
        this.plugin.settings.messengerRoot = value;
        await this.plugin.saveAndReload();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Audit inbox address").setDesc("Senders append OM-1 messages here to file receipts.").addText(
      (text) => text.setValue(this.plugin.settings.inboxAddress).onChange(async (value) => {
        this.plugin.settings.inboxAddress = value;
        await this.plugin.saveAndReload();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Poll interval (seconds)").setDesc("How often the audit inbox is checked.").addText(
      (text) => text.setValue(String(this.plugin.settings.pollSeconds)).onChange(async (value) => {
        const seconds = parseInt(value, 10);
        if (!Number.isNaN(seconds)) {
          this.plugin.settings.pollSeconds = seconds;
          await this.plugin.saveAndReload();
        }
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Retention (days, 0 = keep forever)").setDesc(
      "Off by default: an audit trail that silently ages out is not an audit trail. Pruning whole shards leaves sequence gaps that verify reports as warnings."
    ).addText(
      (text) => text.setValue(String(this.plugin.settings.retentionDays)).onChange(async (value) => {
        const days = parseInt(value, 10);
        if (!Number.isNaN(days)) {
          this.plugin.settings.retentionDays = days;
          await this.plugin.saveAndReload();
        }
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Debug notices").setDesc("Show a notice on every ingest pass that handled messages.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
        this.plugin.settings.debug = value;
        await this.plugin.saveSettings();
      })
    );
    this.addAbout();
  }
  // About footer — same lockup as the Curtis and Curtis Porter settings
  // footers: the brand mark, version, one-line pitch, author, and the Newell
  // NMOJI button pinned bottom-right. Everything lives in one wrapper div
  // because settingEl is a flex row and bare children would sit side by side.
  addAbout() {
    const about = new import_obsidian4.Setting(this.containerEl);
    about.settingEl.addClass("curtis-audit-about");
    about.settingEl.empty();
    const wrap = about.settingEl.createDiv({ cls: "curtis-audit-about-wrap" });
    const title = wrap.createDiv({ cls: "curtis-audit-about-title" });
    const mark = title.createSpan({ cls: "curtis-audit-about-mark", attr: { "aria-hidden": "true" } });
    (0, import_obsidian4.setIcon)(mark, CURTIS_MARK_ICON_ID);
    title.appendText(`Curtis AI Audit v${this.plugin.manifest.version}`);
    wrap.createEl("p", {
      cls: "curtis-audit-about-desc",
      text: "Audit trail for Obsidian \u2014 every AI agent inference gets an append-only markdown receipt, with ingest, query, verify and digest. Local-first, open source."
    });
    const author = wrap.createEl("p", { cls: "curtis-audit-about-desc" });
    author.appendText("By ");
    const link = author.createEl("a", { href: "https://github.com/JordanNewell/curtis-ai-audit" });
    link.setText("Jordan Newell");
    const nmoji = wrap.createDiv({ cls: "curtis-audit-about-nmoji" });
    const nmojiLink = nmoji.createEl("a", {
      href: "https://github.com/JordanNewell",
      attr: { "aria-label": "Newell" }
    });
    nmojiLink.createEl("img", { attr: { src: NMOJI_DATA_URI, alt: "" } });
  }
};

// src/selfaudit.ts
var AUDIT_AGENT = "curtis-ai-audit";
async function recordPruneReceipt(api, dropped, retentionDays) {
  return api.record({
    agent: AUDIT_AGENT,
    action: "prune",
    summary: `Pruned ${dropped} receipt(s) older than ${retentionDays} day(s)`,
    detail: { dropped, retentionDays }
  });
}

// src/hooks-install.ts
var WRITER_MARKER = "curtis-audit-file.mjs";
var CLAUDE_SETTINGS = ".claude/settings.json";
var OPENCODE_PLUGIN = ".opencode/plugin/curtis-audit.js";
function writerCommand(writerPath, inboxPath, agent, extra = []) {
  const args = ["--agent", agent, "--inbox", inboxPath, ...extra];
  const q = (a) => /^[\w.=-]+$/.test(a) ? a : `"${a}"`;
  return `node ${q(writerPath)} ${args.map(q).join(" ")}`;
}
var isOurEntry = (entry) => JSON.stringify(entry).includes(WRITER_MARKER);
function buildClaudeHooks(existing, writerPath, inboxPath) {
  var _a;
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("settings.json is not an object");
  }
  const config = structuredClone(existing);
  const hooks = (_a = config.hooks) != null ? _a : config.hooks = {};
  const added = [];
  const ensure = (event, entry, label) => {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (!list.some(isOurEntry)) {
      hooks[event] = [...list, entry];
      added.push(label);
    }
  };
  ensure(
    "PostToolUse",
    {
      matcher: "*",
      hooks: [{ type: "command", command: writerCommand(writerPath, inboxPath, "claude-code") }]
    },
    "claude-code PostToolUse"
  );
  ensure(
    "Stop",
    {
      hooks: [
        {
          type: "command",
          command: writerCommand(writerPath, inboxPath, "claude-code", ["--action", "agent-turn"])
        }
      ]
    },
    "claude-code Stop"
  );
  return { config, added };
}
function removeClaudeHooks(existing) {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("settings.json is not an object");
  }
  const config = structuredClone(existing);
  const removed = [];
  const hooks = config.hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    const container = hooks;
    for (const event of Object.keys(container)) {
      const list = container[event];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((entry) => {
        if (isOurEntry(entry)) {
          removed.push(`claude-code ${event}`);
          return false;
        }
        return true;
      });
      if (kept.length === 0) delete container[event];
      else container[event] = kept;
    }
    if (Object.keys(container).length === 0) delete config.hooks;
  }
  return { config, removed };
}
function buildOpencodePluginSource(writerPath, inboxPath) {
  const writer = JSON.stringify(writerPath);
  const inbox = JSON.stringify(inboxPath);
  return `// Generated by curtis-ai-audit \u2014 safe to delete; reinstall re-creates it.
// Forwards OpenCode tool activity to the Curtis AI Audit inbox (INTEGRATION.md
// Path C). Only the tool name and path-like metadata are read; payload content
// is never recorded. Hook payload shape is best-effort \u2014 verify against your
// OpenCode version if receipts look wrong.
const WRITER = ${writer};
const INBOX = ${inbox};

export async function CurtisAuditHooks() {
  const { spawn } = await import("node:child_process");
  return {
    "tool.execute.after": async (input, output) => {
      try {
        const metadata = output?.metadata ?? {};
        const payload = {
          tool_name: input?.tool ?? input?.toolName,
          tool_input: {
            file_path: metadata.filePath ?? metadata.file ?? undefined,
            path: metadata.path ?? undefined,
          },
        };
        const child = spawn(process.execPath, [WRITER, "--agent", "opencode", "--inbox", INBOX], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(payload));
        child.unref?.();
      } catch {
        // never break the agent's tool call
      }
    },
  };
}

export default CurtisAuditHooks;
`;
}
function codexNotifyInstructions(writerPath, inboxPath) {
  return `Codex CLI (manual, user-scoped ~/.codex/config.toml):
  notify = ["node", "${writerPath}", "--agent", "codex", "--inbox", "${inboxPath}", "--action", "agent-turn"]
  Turn-level receipts only; Codex passes the payload as an argv JSON string.`;
}
function geminiInstructions(writerPath, inboxPath) {
  return `Gemini CLI (manual \u2014 hook schema still settling, not auto-written):
  AfterTool hook \u2192 node "${writerPath}" --agent gemini --inbox "${inboxPath}"
  See TARGETS.md and your Gemini CLI version's hooks docs.`;
}
async function readJson(io, path) {
  const content = await io.readText(path);
  if (content === null) return "missing";
  try {
    return JSON.parse(content);
  } catch (e) {
    return "malformed";
  }
}
async function installAgentHooks(io, opts) {
  const { writerPath, inboxPath } = opts;
  const results = [];
  const existing = await readJson(io, CLAUDE_SETTINGS);
  if (existing === "malformed") {
    results.push({
      target: "claude-code",
      path: CLAUDE_SETTINGS,
      action: "aborted",
      detail: "existing settings.json is not valid JSON \u2014 left untouched"
    });
  } else {
    const base = existing === "missing" ? {} : existing;
    const { config, added } = buildClaudeHooks(base, writerPath, inboxPath);
    if (added.length === 0) {
      results.push({ target: "claude-code", path: CLAUDE_SETTINGS, action: "already-installed" });
    } else {
      await io.writeText(CLAUDE_SETTINGS, JSON.stringify(config, null, 2) + "\n");
      results.push({
        target: "claude-code",
        path: CLAUDE_SETTINGS,
        action: existing === "missing" ? "added" : "updated",
        detail: added.join(", ")
      });
    }
  }
  const opencodeExisting = await io.readText(OPENCODE_PLUGIN);
  if (opencodeExisting !== null && !opencodeExisting.includes("Generated by curtis-ai-audit")) {
    results.push({
      target: "opencode",
      path: OPENCODE_PLUGIN,
      action: "aborted",
      detail: "a file we did not generate already exists there \u2014 left untouched"
    });
  } else {
    await io.writeText(OPENCODE_PLUGIN, buildOpencodePluginSource(writerPath, inboxPath));
    results.push({
      target: "opencode",
      path: OPENCODE_PLUGIN,
      action: opencodeExisting === null ? "added" : "updated"
    });
  }
  results.push({
    target: "codex",
    action: "manual",
    detail: codexNotifyInstructions(writerPath, inboxPath)
  });
  results.push({
    target: "gemini",
    action: "manual",
    detail: geminiInstructions(writerPath, inboxPath)
  });
  return results;
}
async function uninstallAgentHooks(io) {
  const results = [];
  const claude = await readJson(io, CLAUDE_SETTINGS);
  if (claude === "missing") {
    results.push({ target: "claude-code", path: CLAUDE_SETTINGS, action: "already-installed" });
  } else if (claude === "malformed") {
    results.push({
      target: "claude-code",
      path: CLAUDE_SETTINGS,
      action: "aborted",
      detail: "settings.json is not valid JSON \u2014 left untouched"
    });
  } else {
    const { config, removed } = removeClaudeHooks(claude);
    if (removed.length === 0) {
      results.push({ target: "claude-code", path: CLAUDE_SETTINGS, action: "already-installed" });
    } else {
      await io.writeText(CLAUDE_SETTINGS, JSON.stringify(config, null, 2) + "\n");
      results.push({
        target: "claude-code",
        path: CLAUDE_SETTINGS,
        action: "removed",
        detail: removed.join(", ")
      });
    }
  }
  const opencode = await io.readText(OPENCODE_PLUGIN);
  if (opencode === null) {
    results.push({ target: "opencode", path: OPENCODE_PLUGIN, action: "already-installed" });
  } else if (!opencode.includes("Generated by curtis-ai-audit")) {
    results.push({
      target: "opencode",
      path: OPENCODE_PLUGIN,
      action: "aborted",
      detail: "not ours \u2014 left untouched"
    });
  } else {
    await io.writeText(OPENCODE_PLUGIN, "");
    results.push({ target: "opencode", path: OPENCODE_PLUGIN, action: "removed" });
  }
  return results;
}

// src/main.ts
var PLUGIN_ADDRESS = "curtis-ai-audit";
var PRUNE_EVERY_MS = 60 * 60 * 1e3;
var CurtisAuditPlugin = class extends import_obsidian5.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.lastPump = 0;
    this.lastPrune = 0;
  }
  async onload() {
    await this.loadSettings();
    this.buildComponents();
    await this.joinBusIfPresent();
    await this.ledger.ensureDirs();
    (0, import_obsidian5.addIcon)(CURTIS_MARK_ICON_ID, CURTIS_MARK_SVG);
    this.addRibbonIcon(CURTIS_MARK_ICON_ID, "Curtis AI Audit", () => void this.checkNow());
    this.addCommand({
      id: "check",
      name: "Check audit inbox now",
      callback: () => void this.checkNow()
    });
    this.addCommand({
      id: "verify",
      name: "Verify ledger",
      callback: () => void this.verifyNow()
    });
    this.addCommand({
      id: "digest",
      name: "Write digest",
      callback: () => void this.digestNow()
    });
    this.addCommand({
      id: "prune",
      name: "Prune ledger now",
      callback: () => void this.pruneNow(true)
    });
    this.addCommand({
      id: "open-today",
      name: "Open today's ledger",
      callback: () => void this.openToday()
    });
    this.addCommand({
      id: "install-hooks",
      name: "Install agent audit hooks",
      callback: () => void this.installHooks()
    });
    this.addCommand({
      id: "uninstall-hooks",
      name: "Uninstall agent audit hooks",
      callback: () => void this.uninstallHooks()
    });
    this.registerInterval(window.setInterval(() => this.pumpGate(), 1e3));
    this.addSettingTab(new AuditSettingTab(this.app, this));
  }
  onunload() {
    delete window.curtisAudit;
  }
  buildComponents() {
    this.ledger = new AuditLedger(this.app.vault, this.settings.root);
    this.ingestor = new AuditIngestor(this.app.vault, this.ledger, {
      messengerRoot: this.settings.messengerRoot,
      address: this.settings.inboxAddress
    });
    this.ingestor.setCursors(this.settings.cursors);
    this.api = createApi(this.ledger, this.ingestor, {
      onReceipt: (receipt) => this.app.workspace.trigger("curtis-audit:receipt", receipt)
    });
    window.curtisAudit = this.api;
  }
  /** Settings changes can move the ledger root; rebuild components, keep cursors. */
  async saveAndReload() {
    const cursors = this.ingestor.getCursors();
    await this.saveSettings();
    this.buildComponents();
    this.ingestor.setCursors(cursors);
    await this.ledger.ensureDirs();
    await this.joinBusIfPresent();
  }
  async joinBusIfPresent() {
    const root = this.settings.messengerRoot;
    if (!root) return;
    if (!(this.app.vault.getAbstractFileByPath((0, import_obsidian5.normalizePath)(root)) instanceof import_obsidian5.TFolder)) return;
    const address = this.settings.inboxAddress;
    await ensureFolder(this.app.vault, `${root}/${address}`);
    const inboxPath = (0, import_obsidian5.normalizePath)(`${root}/${address}/inbox.md`);
    if (!(this.app.vault.getAbstractFileByPath(inboxPath) instanceof import_obsidian5.TFile)) {
      await writeFile(this.app.vault, inboxPath, inboxHeader(address));
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await upsertRegistryEntry(this.app.vault, root, {
      address,
      name: "AI audit inbox (append receipts here)",
      updated: now
    });
    await upsertRegistryEntry(this.app.vault, root, {
      address: PLUGIN_ADDRESS,
      name: "Curtis AI Audit (ledger)",
      updated: now
    });
  }
  pumpGate() {
    const intervalMs = Math.max(1, this.settings.pollSeconds) * 1e3;
    if (Date.now() - this.lastPump < intervalMs) return;
    this.lastPump = Date.now();
    void this.pump();
  }
  async pump() {
    try {
      if (!this.settings.messengerRoot) return;
      const result = await this.ingestor.poll();
      if (result.delivered > 0) {
        await this.persistCursors();
        if (this.settings.debug) {
          new import_obsidian5.Notice(
            `Audit: ${result.receipts} receipt(s), ${result.rejected} rejected, ${result.duplicates} duplicate(s)`
          );
        }
      }
      if (this.settings.retentionDays > 0 && Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = Date.now();
        const dropped = await this.runPrune();
        if (dropped > 0) console.info(`[curtis-ai-audit] pruned ${dropped} old receipt(s)`);
      }
    } catch (err) {
      console.error("[curtis-ai-audit] pump failed", err);
    }
  }
  async persistCursors() {
    this.settings.cursors = this.ingestor.getCursors();
    await this.saveData(this.settings);
  }
  async checkNow() {
    if (!this.settings.messengerRoot) {
      new import_obsidian5.Notice("Audit inbox is off (clear Messenger root in settings re-enables it)");
      return;
    }
    const result = await this.ingestor.poll();
    await this.persistCursors();
    if (result.delivered === 0) {
      new import_obsidian5.Notice("Audit inbox: no new messages");
      return;
    }
    new import_obsidian5.Notice(
      `Audit: ${result.receipts} receipt(s), ${result.rejected} rejected, ${result.duplicates} duplicate(s)`
    );
  }
  async verifyNow() {
    const report = await verifyLedger(this.ledger);
    console.log("[curtis-ai-audit] verify report", report);
    if (report.issues.length === 0) {
      new import_obsidian5.Notice(
        `Ledger OK: ${report.receipts} receipt(s) across ${report.shards} shard(s) \u2014 no issues`
      );
      return;
    }
    const errors = report.issues.filter((i) => i.severity === "error").length;
    const warnings = report.issues.length - errors;
    new import_obsidian5.Notice(
      `Ledger ${report.ok ? "OK" : "BROKEN"}: ${report.receipts} receipt(s), ${errors} error(s), ${warnings} warning(s) \u2014 details in console`,
      8e3
    );
  }
  async digestNow() {
    const content = await buildDigest(this.ledger, { days: 1 });
    const path = (0, import_obsidian5.normalizePath)(`${this.settings.root}/digest.md`);
    await this.ledger.writeNote(path, content);
    await this.openFile(path);
    new import_obsidian5.Notice("Audit digest written");
  }
  async pruneNow(notice) {
    if (this.settings.retentionDays <= 0) {
      if (notice) new import_obsidian5.Notice("Retention is off (set it above 0 first)");
      return;
    }
    try {
      const dropped = await this.runPrune();
      if (notice) {
        new import_obsidian5.Notice(dropped === 0 ? "Nothing to prune" : `Pruned ${dropped} old receipt(s)`);
      }
    } catch (err) {
      console.error("[curtis-ai-audit] prune failed", err);
      if (notice) new import_obsidian5.Notice("Prune failed \u2014 see console", 8e3);
    }
  }
  /**
   * Retention pass. A nonzero drop is journaled as an ordinary `prune`
   * receipt, so the sequence gaps verify reports on are explained by the
   * ledger itself (SPEC §7) rather than only by a console line.
   */
  async runPrune() {
    const days = this.settings.retentionDays;
    if (days <= 0) return 0;
    const dropped = await this.ledger.prune(days);
    if (dropped > 0) await recordPruneReceipt(this.api, dropped, days);
    return dropped;
  }
  async openToday() {
    const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const path = this.ledger.shardPath(day);
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof import_obsidian5.TFile)) {
      await this.ledger.ensureDirs();
      await this.ledger.writeNote(path, shardHeader(day));
    }
    await this.openFile(path);
  }
  async openFile(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof import_obsidian5.TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }
  /**
   * Path C (INTEGRATION.md): vault-scoped hook configs that make local agents
   * file receipts to the audit inbox via the bundled writer script. Claude
   * Code settings are merged in place; only this plugin's entries are ever
   * removed by uninstall.
   */
  hookPaths() {
    const adapter = this.app.vault.adapter;
    const base = adapter.getBasePath().replace(/\\/g, "/");
    const root = this.settings.messengerRoot || "Messenger";
    return {
      writerPath: `${base}/${this.manifest.dir}/bin/curtis-audit-file.mjs`,
      inboxPath: `${base}/${root}/${this.settings.inboxAddress}/inbox.md`
    };
  }
  hookIo() {
    const adapter = this.app.vault.adapter;
    return {
      readText: async (p) => {
        try {
          return await adapter.read((0, import_obsidian5.normalizePath)(p));
        } catch (e) {
          return null;
        }
      },
      writeText: async (p, content) => {
        const normalized = (0, import_obsidian5.normalizePath)(p);
        const dir = normalized.split("/").slice(0, -1).join("/");
        if (dir) {
          try {
            await adapter.mkdir(dir);
          } catch (e) {
          }
        }
        await adapter.write(normalized, content);
      }
    };
  }
  async installHooks() {
    const paths = this.hookPaths();
    const writerNote = (0, import_obsidian5.normalizePath)(`${this.manifest.dir}/bin/curtis-audit-file.mjs`);
    if (!await this.app.vault.adapter.exists(writerNote)) {
      new import_obsidian5.Notice("Audit hooks: writer script missing \u2014 reinstall the plugin folder", 1e4);
      return;
    }
    const results = await installAgentHooks(this.hookIo(), paths);
    new import_obsidian5.Notice(this.hookNotice("install", results), 12e3);
  }
  async uninstallHooks() {
    const results = await uninstallAgentHooks(this.hookIo());
    new import_obsidian5.Notice(this.hookNotice("uninstall", results), 12e3);
  }
  hookNotice(verb, results) {
    console.info(`[curtis-ai-audit] hooks ${verb}`, results);
    const summary = (actions) => results.filter((r) => actions.includes(r.action)).map((r) => r.target).join(", ");
    const parts = [];
    const installed = summary(["added", "updated", "removed"]);
    if (installed) parts.push(`${verb}ed: ${installed}`);
    if (results.some((r) => r.action === "already-installed")) parts.push("nothing to change");
    const manual = results.filter((r) => r.action === "manual");
    if (manual.length) parts.push(`manual: ${manual.map((r) => r.target).join(", ")} (see console)`);
    const aborted = results.filter((r) => r.action === "aborted");
    if (aborted.length) parts.push(`skipped: ${aborted.map((r) => r.target).join(", ")}`);
    if (verb === "install") parts.push("approve Claude Code project hooks once via /hooks");
    return `Audit hooks \u2014 ${parts.join(" \xB7 ")}`;
  }
  async loadSettings() {
    this.settings = sanitizeSettings(
      Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    );
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
