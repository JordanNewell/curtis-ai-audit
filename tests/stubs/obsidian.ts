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

export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {}
