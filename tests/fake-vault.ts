/**
 * In-memory vault implementing exactly the surface the core modules use.
 * Mirrors real semantics where they matter: create fails if the file exists
 * (so the ledger's race-retry path is exercised), process() is the atomic
 * read-modify-write.
 */

import { FileManager, TFile, TFolder, normalizePath } from "./stubs/obsidian";

function fileFor(path: string): TFile {
  return new TFile(path);
}

/** FileManager fake routing trashFile back to the vault (tests assert removal,
 *  not where a real client's deleted-files preference would send the file). */
export function fakeFileManager(vault: FakeVault): FileManager {
  return {
    trashFile: async (file: TFile) => {
      await vault.delete(file);
    },
  } as unknown as FileManager;
}

export class FakeVault {
  files = new Map<string, string>();
  folders = new Set<string>();
  processCalls = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [path, data] of Object.entries(initial)) {
      const p = normalizePath(path);
      this.files.set(p, data);
      this.mkdirParents(p);
    }
  }

  private mkdirParents(path: string): void {
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    const p = normalizePath(path);
    if (this.files.has(p)) return fileFor(p);
    const prefix = `${p}/`;
    // a path counts as a folder if anything lives under it, even when files
    // were seeded directly into the map after construction
    const isFolder =
      this.folders.has(p) ||
      Array.from(this.files.keys()).some((fp) => fp.startsWith(prefix)) ||
      Array.from(this.folders).some((fp) => fp.startsWith(prefix));
    if (isFolder) {
      const folder = new TFolder(p);
      for (const filePath of this.files.keys()) {
        if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) {
          folder.children.push(fileFor(filePath));
        }
      }
      for (const folderPath of this.folders) {
        if (folderPath.startsWith(prefix) && !folderPath.slice(prefix.length).includes("/")) {
          folder.children.push(new TFolder(folderPath));
        }
      }
      folder.children.sort((a, b) => a.path.localeCompare(b.path));
      return folder;
    }
    return null;
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(normalizePath(path));
  }

  async create(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    if (this.files.has(p)) throw new Error(`File already exists: ${p}`);
    this.files.set(p, data);
    this.mkdirParents(p);
  }

  async read(file: TFile): Promise<string> {
    const data = this.files.get(file.path);
    if (data === undefined) throw new Error(`missing file: ${file.path}`);
    return data;
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data);
  }

  async delete(file: TFile | TFolder, _force?: boolean): Promise<void> {
    if (file instanceof TFile) {
      this.files.delete(file.path);
      return;
    }
    const prefix = `${file.path}/`;
    for (const filePath of Array.from(this.files.keys())) {
      if (filePath.startsWith(prefix)) this.files.delete(filePath);
    }
  }

  async process(path: string, fn: (data: string) => string): Promise<string> {
    this.processCalls++;
    const p = normalizePath(path);
    const next = fn(this.files.get(p) ?? "");
    this.files.set(p, next);
    return next;
  }

  readRaw(path: string): string | undefined {
    return this.files.get(normalizePath(path));
  }
}
