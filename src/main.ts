import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { AuditLedger, shardHeader } from "./ledger";
import { AuditIngestor, IngestResult } from "./ingest";
import { createApi, CurtisAuditApiV1 } from "./api";
import { AuditSettings, DEFAULT_SETTINGS, sanitizeSettings } from "./settings";
import { AuditSettingTab } from "./settings-tab";
import { VerifyReport, verifyLedger } from "./verify";
import { buildDigest } from "./digest";
import { ensureFolder, inboxHeader, upsertRegistryEntry, writeFile } from "./registry";

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
    window.curtisAudit = this.api;

    // Join the OM-1 registry only when a bus root already exists — never
    // create one on the user's behalf; the messenger plugin may not be
    // installed and direct recording works regardless.
    await this.joinBusIfPresent();
    await this.ledger.ensureDirs();

    this.addRibbonIcon("scroll-text", "Curtis AI Audit", () => void this.checkNow());

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

    // 1s heartbeat gated by the poll-interval setting; setting changes apply live.
    this.registerInterval(window.setInterval(() => this.pumpGate(), 1000));
    this.addSettingTab(new AuditSettingTab(this.app, this));
  }

  onunload(): void {
    delete window.curtisAudit;
  }

  private buildComponents(): void {
    this.ledger = new AuditLedger(this.app.vault, this.settings.root);
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
        const dropped = await this.ledger.prune(this.settings.retentionDays);
        if (dropped > 0) console.info(`[curtis-ai-audit] pruned ${dropped} old receipt(s)`);
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
    console.log("[curtis-ai-audit] verify report", report);
    if (report.issues.length === 0) {
      new Notice(
        `Ledger OK: ${report.receipts} receipt(s) across ${report.shards} shard(s) — no issues`
      );
      return;
    }
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
    const dropped = await this.ledger.prune(this.settings.retentionDays);
    if (notice) {
      new Notice(dropped === 0 ? "Nothing to prune" : `Pruned ${dropped} old receipt(s)`);
    }
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

  async loadSettings(): Promise<void> {
    this.settings = sanitizeSettings(
      Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

export { verifyLedger, buildDigest, IngestResult, VerifyReport };
