import { App, PluginSettingTab, Setting } from "obsidian";
import type CurtisAuditPlugin from "./main";

export class AuditSettingTab extends PluginSettingTab {
  private plugin: CurtisAuditPlugin;

  constructor(app: App, plugin: CurtisAuditPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Curtis AI Audit" });

    new Setting(containerEl)
      .setName("Ledger folder")
      .setDesc("Receipts are appended under <folder>/ledger/, one markdown shard per day.")
      .addText((text) =>
        text.setValue(this.plugin.settings.root).onChange(async (value) => {
          this.plugin.settings.root = value;
          await this.plugin.saveAndReload();
        })
      );

    new Setting(containerEl)
      .setName("Messenger root")
      .setDesc(
        "Folder of the OM-1 bus (default Messenger). The audit inbox is watched at " +
          "<root>/<inbox address>/inbox.md. Clear to disable bus ingest; direct recording " +
          "via window.curtisAudit keeps working."
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.messengerRoot).onChange(async (value) => {
          this.plugin.settings.messengerRoot = value;
          await this.plugin.saveAndReload();
        })
      );

    new Setting(containerEl)
      .setName("Audit inbox address")
      .setDesc("Senders append OM-1 messages here to file receipts.")
      .addText((text) =>
        text.setValue(this.plugin.settings.inboxAddress).onChange(async (value) => {
          this.plugin.settings.inboxAddress = value;
          await this.plugin.saveAndReload();
        })
      );

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often the audit inbox is checked.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pollSeconds)).onChange(async (value) => {
          const seconds = parseInt(value, 10);
          if (!Number.isNaN(seconds)) {
            this.plugin.settings.pollSeconds = seconds;
            await this.plugin.saveAndReload();
          }
        })
      );

    new Setting(containerEl)
      .setName("Retention (days, 0 = keep forever)")
      .setDesc(
        "Off by default: an audit trail that silently ages out is not an audit trail. " +
          "Pruning whole shards leaves sequence gaps that verify reports as warnings."
      )
      .addText((text) =>
        text.setValue(String(this.plugin.settings.retentionDays)).onChange(async (value) => {
          const days = parseInt(value, 10);
          if (!Number.isNaN(days)) {
            this.plugin.settings.retentionDays = days;
            await this.plugin.saveAndReload();
          }
        })
      );

    new Setting(containerEl)
      .setName("Debug notices")
      .setDesc("Show a notice on every ingest pass that handled messages.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
          this.plugin.settings.debug = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
