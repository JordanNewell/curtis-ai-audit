import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type CurtisAuditPlugin from "./main";
import { CURTIS_MARK_ICON_ID } from "./icon";
import { NMOJI_DATA_URI } from "./nmoji";

/** Brand lockup (mark + name) as a fragment, for setName() on heading rows. */
function brandNameFragment(): DocumentFragment {
  const frag = document.createDocumentFragment();
  const mark = document.createElement("span");
  mark.className = "curtis-audit-mark";
  setIcon(mark, CURTIS_MARK_ICON_ID);
  frag.appendChild(mark);
  frag.appendChild(document.createTextNode("Curtis AI Audit"));
  return frag;
}

/**
 * About footer — same lockup as the Curtis and Curtis Porter settings
 * footers: the brand mark, version, one-line pitch, author, and the Newell
 * NMOJI button pinned bottom-right. Everything lives in one wrapper div
 * because settingEl is a flex row and bare children would sit side by side.
 */
function renderAbout(setting: Setting, version: string): void {
  setting.settingEl.addClass("curtis-audit-about");
  setting.settingEl.empty();

  const wrap = setting.settingEl.createDiv({ cls: "curtis-audit-about-wrap" });
  const title = wrap.createDiv({ cls: "curtis-audit-about-title" });
  const mark = title.createSpan({ cls: "curtis-audit-about-mark", attr: { "aria-hidden": "true" } });
  // Registered by main.ts (addIcon) at startup.
  setIcon(mark, CURTIS_MARK_ICON_ID);
  title.appendText(`Curtis AI Audit v${version}`);

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

export class AuditSettingTab extends PluginSettingTab {
  private plugin: CurtisAuditPlugin;

  constructor(app: App, plugin: CurtisAuditPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Declarative settings (Obsidian 1.13+): the tab renders from these
   * definitions and they feed the settings search index. Values flow through
   * getControlValue/setControlValue below; display() is the pre-1.13
   * fallback (minAppVersion is 1.4.0).
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Curtis AI Audit",
        searchable: false,
        render: (setting) => {
          setting.setName(brandNameFragment()).setHeading();
        },
      },
      {
        name: "Ledger folder",
        desc: "Receipts are appended under <folder>/ledger/, one markdown shard per day.",
        control: { type: "text", key: "root", placeholder: "Audit" },
      },
      {
        name: "Messenger root",
        desc:
          "Folder of the OM-1 bus (default Messenger). The audit inbox is watched at " +
          "<root>/<inbox address>/inbox.md. Clear to disable bus ingest; direct recording " +
          "via window.curtisAudit keeps working.",
        control: { type: "text", key: "messengerRoot", placeholder: "Messenger" },
      },
      {
        name: "Audit inbox address",
        desc: "Senders append OM-1 messages here to file receipts.",
        control: { type: "text", key: "inboxAddress", placeholder: "audit" },
      },
      {
        name: "Poll interval (seconds)",
        desc: "How often the audit inbox is checked.",
        control: { type: "number", key: "pollSeconds", min: 1, max: 3600, step: 1 },
      },
      {
        name: "Retention (days, 0 = keep forever)",
        desc:
          "Off by default: an audit trail that silently ages out is not an audit trail. " +
          "Pruning whole shards leaves sequence gaps that verify reports as warnings.",
        control: { type: "number", key: "retentionDays", min: 0, max: 36500, step: 1 },
      },
      {
        name: "Debug notices",
        desc: "Show a notice on every ingest pass that handled messages.",
        control: { type: "toggle", key: "debug" },
      },
      {
        name: "About",
        searchable: false,
        render: (setting) => {
          renderAbout(setting, this.plugin.manifest.version);
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    if (!(key in settings)) return;
    settings[key] = value;
    return this.plugin.saveAndReload();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(brandNameFragment()).setHeading();

    new Setting(containerEl)
      .setName("Ledger folder")
      .setDesc("Receipts are appended under <folder>/ledger/, one markdown shard per day.")
      .addText((text) =>
        text
          .setPlaceholder("Audit")
          .setValue(this.plugin.settings.root)
          .onChange(async (value) => {
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
        text
          .setPlaceholder("Messenger")
          .setValue(this.plugin.settings.messengerRoot)
          .onChange(async (value) => {
            this.plugin.settings.messengerRoot = value;
            await this.plugin.saveAndReload();
          })
      );

    new Setting(containerEl)
      .setName("Audit inbox address")
      .setDesc("Senders append OM-1 messages here to file receipts.")
      .addText((text) =>
        text
          .setPlaceholder("audit")
          .setValue(this.plugin.settings.inboxAddress)
          .onChange(async (value) => {
            this.plugin.settings.inboxAddress = value;
            await this.plugin.saveAndReload();
          })
      );

    new Setting(containerEl)
      .setName("Poll interval (seconds)")
      .setDesc("How often the audit inbox is checked.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pollSeconds))
          .onChange(async (value) => {
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
        text
          .setValue(String(this.plugin.settings.retentionDays))
          .onChange(async (value) => {
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

    renderAbout(new Setting(containerEl), this.plugin.manifest.version);
  }
}
