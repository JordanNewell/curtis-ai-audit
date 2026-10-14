/**
 * Minimal stand-in for the obsidian module, for vitest only. Only the
 * surface the core modules touch: TFile/TFolder (instanceof checks),
 * normalizePath, and the Vault base class for typing.
 */

export class TAbstractFile {
  path: string;
  name: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  constructor(path: string) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === "/";
  }
}

export class Vault {}

export class FileManager {}

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** Mirrors real Obsidian: the base class captures the app and manifest. */
export class Plugin {
  app: unknown;
  manifest: unknown;
  constructor(app?: unknown, manifest?: unknown) {
    this.app = app;
    this.manifest = manifest;
  }
}
export class PluginSettingTab {}

/** Minimal DOM-ish element so Modal/Setting render calls record instead of crash. */
function fakeEl(): Record<string, unknown> & {
  children: Record<string, unknown>[];
  text: string;
  __settings: unknown[];
} {
  const el: Record<string, unknown> & {
    children: Record<string, unknown>[];
    text: string;
    __settings: unknown[];
  } = {
    children: [],
    text: "",
    __settings: [],
    setText(t: string) {
      el.text = t;
      return el;
    },
    appendText(t: string) {
      el.text += t;
      return el;
    },
    createDiv(opts?: { cls?: string }) {
      const d = fakeEl();
      if (opts?.cls) d.cls = opts.cls;
      el.children.push(d);
      return d;
    },
    createSpan(opts?: { cls?: string }) {
      return el.createDiv(opts) as never;
    },
    createEl(tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) {
      const c = fakeEl();
      (c as { tag: string }).tag = tag;
      if (opts?.cls) c.cls = opts.cls;
      if (opts?.text) c.text = opts.text;
      if (opts?.attr) c.attr = opts.attr;
      el.children.push(c);
      return c;
    },
    empty() {
      el.children = [];
      return el;
    },
    addClass() {
      return el;
    },
    setCssStyles() {
      return el;
    },
  };
  return el;
}

export class Modal {
  titleEl = fakeEl();
  contentEl = fakeEl();
  constructor(public app?: unknown) {}
  open(): void {}
  close(): void {}
}

/** Chainable settings row; registers itself on the container for assertions. */
export class Setting {
  settingEl = fakeEl();
  nameEl = fakeEl();
  descEl = fakeEl();
  controlEl = fakeEl();
  buttonClick: ((button: unknown) => void) | null = null;

  constructor(containerEl?: unknown) {
    const c = containerEl as { __settings?: unknown[] } | undefined;
    c?.__settings?.push(this);
  }
  setName(value: unknown): this {
    this.nameEl.text = String(value);
    return this;
  }
  setDesc(value: unknown): this {
    this.descEl.text = String(value);
    return this;
  }
  setHeading(): this {
    return this;
  }
  addButton(build: (button: unknown) => unknown): this {
    const button = {
      setButtonText: () => button,
      onClick: (fn: (button: unknown) => void) => {
        this.buttonClick = fn;
        return button;
      },
    };
    build(button);
    return this;
  }
}

export class Notice {
  constructor(public message?: string, public timeout?: number) {}
}

export function addIcon(_iconId: string, _svgContent: string): void {}
export function setIcon(_parent: unknown, _iconId: string): void {}

export class FileSystemAdapter {
  getBasePath(): string {
    return "";
  }
}
