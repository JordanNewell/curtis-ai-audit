/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

/**
 * The ledger: one append-only markdown shard per day under
 * `<root>/ledger/YYYY-MM-DD.md`. Each receipt is a `curtis-audit:` block —
 * canonical-JSON receipt in the envelope, rendered summary in the body.
 *
 * Sequence numbers are handed out by the ledger (claimSeq), one monotonic
 * series per agent across all shards. Gaps in a series mean receipts were
 * deleted (or a write failed) — that is detect-without-crypto tamper
 * evidence, which is exactly as far as a local-first journal goes.
 */

import { FileManager, TFile, TFolder, Vault, normalizePath } from "obsidian";
import {
  ensureFolder,
  mutateFileAtomic,
  writeFile,
} from "./registry";
import { canonicalJson, encodeBlock, parseBlocks } from "./protocol";
import { AuditReceiptV1, RECEIPT_SCHEMA, renderReceipt, validateReceipt } from "./schema";

export const LEDGER_MARKER = "curtis-audit";

const SHARD_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export function shardHeader(day: string): string {
  return (
    `# Audit ledger — ${day}\n\n` +
    "Append-only receipts, oldest first. Envelopes are canonical JSON (audit.v1); " +
    "bodies are human summaries. Do not reorder or edit blocks. See SPEC.md.\n\n"
  );
}

interface LedgerState {
  version: number;
  agents: Record<string, { lastSeq: number }>;
  updated: string;
}

export interface ShardRead {
  receipts: AuditReceiptV1[];
  /** Total parseable ledger blocks, valid or not. */
  blocks: number;
  /** Written blocks that failed to parse or failed validation. */
  malformed: number;
}

export class AuditLedger {
  private seqByAgent = new Map<string, number>();
  private stateLoaded = false;
  private stateDirty = false;

  constructor(private vault: Vault, private fileManager: FileManager, private root: string) {}

  get ledgerDir(): string {
    return normalizePath(`${this.root}/ledger`);
  }

  get statePath(): string {
    return normalizePath(`${this.root}/state.json`);
  }

  shardPath(day: string): string {
    return normalizePath(`${this.root}/ledger/${day}.md`);
  }

  async ensureDirs(): Promise<void> {
    await ensureFolder(this.vault, `${this.root}/ledger`);
  }

  /** Reserve the next sequence number for an agent (monotonic, per agent). */
  async claimSeq(agent: string): Promise<number> {
    await this.ensureStateLoaded();
    const next = (this.seqByAgent.get(agent) ?? -1) + 1;
    this.seqByAgent.set(agent, next);
    this.stateDirty = true;
    return next;
  }

  /** Write a receipt to the shard for its `recorded` day. Append-only. */
  async append(receipt: AuditReceiptV1): Promise<void> {
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
    if (file instanceof TFile) {
      await mutateFileAtomic(this.vault, path, (content) => content.replace(/\s+$/, "\n\n") + block);
      return;
    }
    try {
      await this.vault.create(path, shardHeader(day) + block);
    } catch {
      // raced with another writer creating the file — retry as an existing file
      const existing = this.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await mutateFileAtomic(this.vault, path, (content) => content.replace(/\s+$/, "\n\n") + block);
      }
    }
  }

  async saveState(): Promise<void> {
    if (!this.stateDirty) return;
    const agents: Record<string, { lastSeq: number }> = {};
    for (const [agent, lastSeq] of this.seqByAgent) agents[agent] = { lastSeq };
    const state: LedgerState = {
      version: 1,
      agents,
      updated: new Date().toISOString(),
    };
    await writeFile(this.vault, this.statePath, canonicalJson(state) + "\n");
    this.stateDirty = false;
  }

  /** Day-file paths, sorted oldest first. */
  listShards(): string[] {
    const dir = this.vault.getAbstractFileByPath(this.ledgerDir);
    if (!(dir instanceof TFolder)) return [];
    return dir.children
      .filter((child): child is TFile => child instanceof TFile && SHARD_RE.test(child.name))
      .map((f) => f.path)
      .sort();
  }

  async readShard(path: string): Promise<ShardRead> {
    const out: ShardRead = { receipts: [], blocks: 0, malformed: 0 };
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return out;
    const content = await this.vault.read(file);
    const blocks = parseBlocks(content, LEDGER_MARKER);
    out.blocks = blocks.length;
    // parseBlocks silently skips unparseable blocks; count written openings
    // that never made it through so "verify" can surface them
    const openings = content.split(`<!-- ${LEDGER_MARKER}:`).length - 1;
    out.malformed = Math.max(0, openings - out.blocks);
    for (const block of blocks) {
      const check = validateReceipt(block.header);
      if (check.ok) {
        out.receipts.push(block.header as unknown as AuditReceiptV1);
      } else {
        out.malformed++;
      }
    }
    return out;
  }

  async readAll(): Promise<AuditReceiptV1[]> {
    const all: AuditReceiptV1[] = [];
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
   * gaps; that trade-off is documented in SPEC.md. Emptied shards go to the
   * trash (respecting the user's deletion preference), not a hard delete.
   */
  async prune(maxAgeDays: number): Promise<number> {
    if (maxAgeDays <= 0) return 0;
    const cutoff = Date.now() - maxAgeDays * 86400000;
    let dropped = 0;
    for (const path of this.listShards()) {
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const read = await this.readShard(path);
      if (read.blocks === 0) continue; // leave non-ledger content alone
      const kept = read.receipts.filter((r) => Date.parse(r.recorded) >= cutoff);
      dropped += read.receipts.length - kept.length;
      if (kept.length === 0) {
        await this.fileManager.trashFile(file);
      } else if (kept.length !== read.receipts.length) {
        const day = file.name.replace(/\.md$/, "");
        const content = shardHeader(day) + kept.map(renderBlock).join("");
        await this.vault.modify(file, content);
      }
    }
    return dropped;
  }

  /** Write (or replace) a companion note such as digest.md. */
  async writeNote(relPath: string, content: string): Promise<void> {
    await writeFile(this.vault, relPath, content);
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    const file = this.vault.getAbstractFileByPath(this.statePath);
    if (file instanceof TFile) {
      try {
        const state = JSON.parse(await this.vault.read(file)) as LedgerState;
        if (state && typeof state === "object" && state.agents && typeof state.agents === "object") {
          for (const agent of Object.keys(state.agents)) {
            const lastSeq = state.agents[agent]?.lastSeq;
            if (typeof lastSeq === "number" && Number.isInteger(lastSeq) && lastSeq >= 0) {
              this.seqByAgent.set(agent, lastSeq);
            }
          }
          return;
        }
      } catch {
        // corrupt state — fall through to a rebuild scan
      }
    }
    await this.rebuildState();
  }

  /** Scan every shard and recompute per-agent sequence high-water marks. */
  async rebuildState(): Promise<void> {
    this.seqByAgent.clear();
    for (const receipt of await this.readAll()) {
      const last = this.seqByAgent.get(receipt.agent);
      if (last === undefined || receipt.seq > last) this.seqByAgent.set(receipt.agent, receipt.seq);
    }
    this.stateDirty = true;
    await this.saveState();
  }
}

function renderBlock(receipt: AuditReceiptV1): string {
  return encodeBlock(
    LEDGER_MARKER,
    receipt,
    renderReceipt(receipt)
  );
}

export { RECEIPT_SCHEMA };
