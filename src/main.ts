/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

import {
  FileSystemAdapter,
  Notice,
  Plugin,
  TFile,
  TFolder,
  addIcon,
  normalizePath,
} from "obsidian";
import { CURTIS_MARK_ICON_ID, CURTIS_MARK_SVG } from "./icon";
import { AuditLedger, shardHeader } from "./ledger";
import { AuditIngestor, IngestResult } from "./ingest";
import { createApi, CurtisAuditApiV1 } from "./api";
import { AuditSettings, DEFAULT_SETTINGS, sanitizeSettings } from "./settings";
import { AuditSettingTab } from "./settings-tab";
import { VerifyReport, verifyLedger } from "./verify";
import { buildDigest } from "./digest";
import { recordPruneReceipt } from "./selfaudit";
import { ensureFolder, inboxHeader, upsertRegistryEntry, writeFile } from "./registry";
import {
  HookIo,
  HookTargetResult,
  installAgentHooks,
  uninstallAgentHooks,
} from "./hooks-install";
import { HooksManualModal } from "./hooks-modal";

const PLUGIN_ADDRESS = "curtis-ai-audit";
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export default class CurtisAuditPlugin extends Plugin {
  settings: AuditSettings = DEFAULT_SETTINGS;
  ledger!: AuditLedger;
  ingestor!: AuditIngestor;
  api!: CurtisAuditApiV1;

  private lastPump = 0;
  private lastPrune = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.buildComponents();

    // Join the OM-1 registry only when a bus root already exists — never
    // create one on the user's behalf; the messenger plugin may not be
    // installed and direct recording works regardless.
    await this.joinBusIfPresent();
    await this.ledger.ensureDirs();

    addIcon(CURTIS_MARK_ICON_ID, CURTIS_MARK_SVG);
    this.addRibbonIcon(CURTIS_MARK_ICON_ID, "Curtis AI Audit", () => void this.checkNow());

    this.addCommand({
      id: "check",
      name: "Check audit inbox now",
      callback: () => void this.checkNow(),
    });
    this.addCommand({
      id: "verify",
      name: "Verify ledger",
      callback: () => void this.verifyNow(),
    });
    this.addCommand({
      id: "digest",
      name: "Write digest",
      callback: () => void this.digestNow(),
    });
    this.addCommand({
      id: "prune",
      name: "Prune ledger now",
      callback: () => void this.pruneNow(true),
    });
    this.addCommand({
      id: "open-today",
      name: "Open today's ledger",
      callback: () => void this.openToday(),
    });
    this.addCommand({
      id: "install-hooks",
      name: "Install agent audit hooks",
      callback: () => void this.installHooks(),
    });
    this.addCommand({
      id: "uninstall-hooks",
      name: "Uninstall agent audit hooks",
      callback: () => void this.uninstallHooks(),
    });

    // 1s heartbeat gated by the poll-interval setting; setting changes apply live.
    this.registerInterval(window.setInterval(() => this.pumpGate(), 1000));
    this.addSettingTab(new AuditSettingTab(this.app, this));
  }

  onunload(): void {
    delete window.curtisAudit;
  }

  private buildComponents(): void {
    this.ledger = new AuditLedger(this.app.vault, this.app.fileManager, this.settings.root);
    this.ingestor = new AuditIngestor(this.app.vault, this.ledger, {
      messengerRoot: this.settings.messengerRoot,
      address: this.settings.inboxAddress,
    });
    this.ingestor.setCursors(this.settings.cursors);
    this.api = createApi(this.ledger, this.ingestor, {
      onReceipt: (receipt) => this.app.workspace.trigger("curtis-audit:receipt", receipt),
    });
    window.curtisAudit = this.api;
  }

  /** Settings changes can move the ledger root; rebuild components, keep cursors. */
  async saveAndReload(): Promise<void> {
    const cursors = this.ingestor.getCursors();
    await this.saveSettings();
    this.buildComponents();
    this.ingestor.setCursors(cursors);
    await this.ledger.ensureDirs();
    await this.joinBusIfPresent();
  }

  private async joinBusIfPresent(): Promise<void> {
    const root = this.settings.messengerRoot;
    if (!root) return;
    if (!(this.app.vault.getAbstractFileByPath(normalizePath(root)) instanceof TFolder)) return;
    const address = this.settings.inboxAddress;
    await ensureFolder(this.app.vault, `${root}/${address}`);
    const inboxPath = normalizePath(`${root}/${address}/inbox.md`);
    if (!(this.app.vault.getAbstractFileByPath(inboxPath) instanceof TFile)) {
      await writeFile(this.app.vault, inboxPath, inboxHeader(address));
    }
    const now = new Date().toISOString();
    await upsertRegistryEntry(this.app.vault, root, {
      address,
      name: "AI audit inbox (append receipts here)",
      updated: now,
    });
    await upsertRegistryEntry(this.app.vault, root, {
      address: PLUGIN_ADDRESS,
      name: "Curtis AI Audit (ledger)",
      updated: now,
    });
  }

  private pumpGate(): void {
    const intervalMs = Math.max(1, this.settings.pollSeconds) * 1000;
    if (Date.now() - this.lastPump < intervalMs) return;
    this.lastPump = Date.now();
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      if (!this.settings.messengerRoot) return;
      const result = await this.ingestor.poll();
      if (result.delivered > 0) {
        await this.persistCursors();
        if (this.settings.debug) {
          new Notice(
            `Audit: ${result.receipts} receipt(s), ${result.rejected} rejected, ` +
              `${result.duplicates} duplicate(s)`
          );
        }
      }
      if (this.settings.retentionDays > 0 && Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
        this.lastPrune = Date.now();
        await this.runPrune();
      }
    } catch (err) {
      console.error("[curtis-ai-audit] pump failed", err);
    }
  }

  private async persistCursors(): Promise<void> {
    this.settings.cursors = this.ingestor.getCursors();
    await this.saveData(this.settings);
  }

  private async checkNow(): Promise<void> {
    if (!this.settings.messengerRoot) {
      new Notice("Audit inbox is off (clear Messenger root in settings re-enables it)");
      return;
    }
    const result = await this.ingestor.poll();
    await this.persistCursors();
    if (result.delivered === 0) {
      new Notice("Audit inbox: no new messages");
      return;
    }
    new Notice(
      `Audit: ${result.receipts} receipt(s), ${result.rejected} rejected, ` +
        `${result.duplicates} duplicate(s)`
    );
  }

  private async verifyNow(): Promise<void> {
    const report = await verifyLedger(this.ledger);
    if (report.issues.length === 0) {
      new Notice(
        `Ledger OK: ${report.receipts} receipt(s) across ${report.shards} shard(s) — no issues`
      );
      return;
    }
    // necessary diagnostics: the notice points here for the per-issue detail
    console.error("[curtis-ai-audit] verify issues", report.issues);
    const errors = report.issues.filter((i) => i.severity === "error").length;
    const warnings = report.issues.length - errors;
    new Notice(
      `Ledger ${report.ok ? "OK" : "BROKEN"}: ${report.receipts} receipt(s), ` +
        `${errors} error(s), ${warnings} warning(s) — details in console`,
      8000
    );
  }

  private async digestNow(): Promise<void> {
    const content = await buildDigest(this.ledger, { days: 1 });
    const path = normalizePath(`${this.settings.root}/digest.md`);
    await this.ledger.writeNote(path, content);
    await this.openFile(path);
    new Notice("Audit digest written");
  }

  private async pruneNow(notice: boolean): Promise<void> {
    if (this.settings.retentionDays <= 0) {
      if (notice) new Notice("Retention is off (set it above 0 first)");
      return;
    }
    try {
      const dropped = await this.runPrune();
      if (notice) {
        new Notice(dropped === 0 ? "Nothing to prune" : `Pruned ${dropped} old receipt(s)`);
      }
    } catch (err) {
      console.error("[curtis-ai-audit] prune failed", err);
      if (notice) new Notice("Prune failed — see console", 8000);
    }
  }

  /**
   * Retention pass. A nonzero drop is journaled as an ordinary `prune`
   * receipt, so the sequence gaps verify reports on are explained by the
   * ledger itself (SPEC §7) rather than only by a console line.
   */
  private async runPrune(): Promise<number> {
    const days = this.settings.retentionDays;
    if (days <= 0) return 0;
    const dropped = await this.ledger.prune(days);
    if (dropped > 0) await recordPruneReceipt(this.api, dropped, days);
    return dropped;
  }

  private async openToday(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const path = this.ledger.shardPath(day);
    if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) {
      await this.ledger.ensureDirs();
      await this.ledger.writeNote(path, shardHeader(day));
    }
    await this.openFile(path);
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }

  /**
   * Path C (INTEGRATION.md): vault-scoped hook configs that make local agents
   * file receipts to the audit inbox via the bundled writer script. Claude
   * Code settings are merged in place; only this plugin's entries are ever
   * removed by uninstall.
   */
  private hookPaths(): { writerPath: string; inboxPath: string } | null {
    // getBasePath() only exists on the desktop FileSystemAdapter; on mobile
    // there is no local writer for agents to call anyway.
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return null;
    const base = this.app.vault.adapter.getBasePath().replace(/\\/g, "/");
    const root = this.settings.messengerRoot || "Messenger";
    return {
      writerPath: `${base}/${this.manifest.dir}/bin/curtis-audit-file.mjs`,
      inboxPath: `${base}/${root}/${this.settings.inboxAddress}/inbox.md`,
    };
  }

  private hookIo(): HookIo {
    const adapter = this.app.vault.adapter;
    return {
      readText: async (p) => {
        try {
          return await adapter.read(normalizePath(p));
        } catch {
          return null;
        }
      },
      writeText: async (p, content) => {
        const normalized = normalizePath(p);
        const dir = normalized.split("/").slice(0, -1).join("/");
        if (dir) {
          try {
            await adapter.mkdir(dir);
          } catch {
            // already exists
          }
        }
        await adapter.write(normalized, content);
      },
    };
  }

  private async installHooks(): Promise<void> {
    const paths = this.hookPaths();
    if (!paths) {
      new Notice("Agent audit hooks are desktop-only (they run a local writer script)", 8000);
      return;
    }
    const writerNote = normalizePath(`${this.manifest.dir}/bin/curtis-audit-file.mjs`);
    if (!(await this.app.vault.adapter.exists(writerNote))) {
      new Notice("Audit hooks: writer script missing — reinstall the plugin folder", 10000);
      return;
    }
    const results = await installAgentHooks(this.hookIo(), paths);
    new Notice(this.hookNotice("install", results), 12000);
    this.showManualSetup(results);
  }

  private async uninstallHooks(): Promise<void> {
    const results = await uninstallAgentHooks(this.hookIo());
    new Notice(this.hookNotice("uninstall", results), 12000);
    this.showManualSetup(results);
  }

  /**
   * Codex and Gemini targets come back as "manual": recipes the plugin will
   * not auto-write (user-scoped or schema-unverified). Show them in a
   * copyable modal instead of pointing the user at a console.
   */
  private showManualSetup(results: HookTargetResult[]): void {
    const manual = results.filter((r) => r.action === "manual");
    if (manual.length > 0) new HooksManualModal(this.app, manual).open();
  }

  private hookNotice(verb: string, results: HookTargetResult[]): string {
    const summary = (actions: HookTargetResult["action"][]): string =>
      results
        .filter((r) => actions.includes(r.action))
        .map((r) => r.target)
        .join(", ");
    const parts: string[] = [];
    const installed = summary(["added", "updated", "removed"]);
    if (installed) parts.push(`${verb}ed: ${installed}`);
    if (results.some((r) => r.action === "already-installed")) parts.push("nothing to change");
    const manual = results.filter((r) => r.action === "manual");
    if (manual.length) parts.push(`manual: ${manual.map((r) => r.target).join(", ")}`);
    const aborted = results.filter((r) => r.action === "aborted");
    if (aborted.length) parts.push(`skipped: ${aborted.map((r) => r.target).join(", ")}`);
    if (verb === "install") parts.push("approve Claude Code project hooks once via /hooks");
    return `Audit hooks — ${parts.join(" · ")}`;
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<AuditSettings> | null;
    this.settings = sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, stored));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

export { verifyLedger, buildDigest, IngestResult, VerifyReport };
