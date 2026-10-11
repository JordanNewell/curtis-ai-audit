import { App, Modal, Notice, Setting } from "obsidian";
import type { HookTargetResult } from "./hooks-install";

/**
 * The manual half of Path C (INTEGRATION.md): Codex and Gemini configs are
 * user-scoped or schema-unverified, so the plugin surfaces copyable recipes
 * instead of writing them. A modal rather than the console — there is no
 * console to read on mobile, and desktop consoles scroll away.
 */
export class HooksManualModal extends Modal {
  constructor(app: App, private results: HookTargetResult[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Agent audit hooks — manual setup");
    for (const result of this.results) {
      const setting = new Setting(this.contentEl)
        .setName(result.target)
        .setDesc(result.detail ?? "");
      setting.descEl.setCssStyles({ whiteSpace: "pre-wrap" });
      setting.addButton((button) =>
        button.setButtonText("Copy").onClick(() => {
          this.copy(result.target, result.detail ?? "");
        })
      );
    }
  }

  private copy(target: string, text: string): void {
    if (!navigator.clipboard?.writeText) {
      new Notice("Clipboard unavailable — select the text manually", 5000);
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => new Notice(`Copied ${target} instructions`))
      .catch(() => new Notice("Copy failed — select the text manually", 5000));
  }
}
