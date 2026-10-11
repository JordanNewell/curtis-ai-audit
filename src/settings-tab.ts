import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type CurtisAuditPlugin from "./main";
import { CURTIS_MARK_ICON_ID } from "./icon";
import { NMOJI_DATA_URI } from "./nmoji";

export class AuditSettingTab extends PluginSettingTab {
  private plugin: CurtisAuditPlugin;

  constructor(app: App, plugin: CurtisAuditPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const heading = containerEl.createEl("h2");
    setIcon(heading.createSpan({ cls: "curtis-audit-mark" }), CURTIS_MARK_ICON_ID);
    heading.appendText("Curtis AI Audit");

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

    this.addAbout();
  }

  // About footer — same lockup as the Curtis and Curtis Porter settings
  // footers: the brand mark, version, one-line pitch, author, and the Newell
  // NMOJI button pinned bottom-right. Everything lives in one wrapper div
  // because settingEl is a flex row and bare children would sit side by side.
  private addAbout(): void {
    const about = new Setting(this.containerEl);
    about.settingEl.addClass("curtis-audit-about");
    about.settingEl.empty();

    const wrap = about.settingEl.createDiv({ cls: "curtis-audit-about-wrap" });
    const title = wrap.createDiv({ cls: "curtis-audit-about-title" });
    const mark = title.createSpan({ cls: "curtis-audit-about-mark", attr: { "aria-hidden": "true" } });
    // Registered by main.ts (addIcon) at startup.
    setIcon(mark, CURTIS_MARK_ICON_ID);
    title.appendText(`Curtis AI Audit v${this.plugin.manifest.version}`);

    wrap.createEl("p", {
      cls: "curtis-audit-about-desc",
      text:
        "Audit trail for Obsidian — every AI agent inference gets an append-only " +
        "markdown receipt, with ingest, query, verify and digest. Local-first, open source.",
    });

    const author = wrap.createEl("p", { cls: "curtis-audit-about-desc" });
    author.appendText("By ");
    const link = author.createEl("a", { href: "https://github.com/JordanNewell/curtis-ai-audit" });
    link.setText("Jordan Newell");

    // Author brand mark, pinned to the footer's bottom-right corner (CSS).
    const nmoji = wrap.createDiv({ cls: "curtis-audit-about-nmoji" });
    const nmojiLink = nmoji.createEl("a", {
      href: "https://github.com/JordanNewell",
      attr: { "aria-label": "Newell" },
    });
    nmojiLink.createEl("img", { attr: { src: NMOJI_DATA_URI, alt: "" } });
  }
}
