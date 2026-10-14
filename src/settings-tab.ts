/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type CurtisAuditPlugin from "./main";
import { AuditSettings, sanitizeSettings } from "./settings";
import { CURTIS_MARK_ICON_ID } from "./icon";
import { NMOJI_DATA_URI } from "./nmoji";

/** Brand lockup (mark + name) as a fragment, for setName() on heading rows. */
function brandNameFragment(): DocumentFragment {
  return createFragment((frag) => {
    const mark = frag.createSpan({ cls: "curtis-audit-mark" });
    setIcon(mark, CURTIS_MARK_ICON_ID);
    frag.appendText("Curtis AI Audit");
  });
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

/**
 * Declarative settings tab (Obsidian 1.13+, which is also minAppVersion):
 * the tab renders from these definitions and they feed the settings search
 * index. Values flow through getControlValue/setControlValue below.
 */
export class AuditSettingTab extends PluginSettingTab {
  private plugin: CurtisAuditPlugin;

  constructor(app: App, plugin: CurtisAuditPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

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
    // Single sanitize choke point: the raw control value is cleaned before
    // the reload persists it to data.json. The sanitized result is copied
    // back onto the same object — components hold this reference, so it must
    // not be swapped out from under them. setControlValue is the commit
    // boundary (not per keystroke), so clamped values only land after commit.
    const sanitized = sanitizeSettings(this.plugin.settings);
    for (const k of Object.keys(sanitized) as (keyof AuditSettings)[]) {
      settings[k] = sanitized[k];
    }
    return this.plugin.saveAndReload();
  }
}
