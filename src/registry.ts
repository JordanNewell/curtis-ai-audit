/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

/**
 * Generic vault file helpers, shared by the ledger and the bus integration.
 * The patterns mirror obsidian-messenger's MailboxStore: atomic read-modify-
 * write via Vault#process where available, and race-tolerant creation.
 */

import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import { ADDRESS_RE } from "./protocol";

export interface RegistryEntry {
  address: string;
  name: string;
  updated: string;
}

/** Creates a folder (and parents) if missing; tolerates races. */
export async function ensureFolder(vault: Vault, relPath: string): Promise<void> {
  const path = normalizePath(relPath);
  if (!path) return;
  if (vault.getAbstractFileByPath(path) instanceof TFolder) return;
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (vault.getAbstractFileByPath(current) instanceof TFolder) continue;
    try {
      await vault.createFolder(current);
    } catch {
      // already exists (race) — the loop's existence check handles it
    }
  }
}

export async function writeFile(vault: Vault, path: string, content: string): Promise<void> {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  await ensureFolder(vault, parts.join("/"));
  const file = vault.getAbstractFileByPath(normalized);
  if (file instanceof TFile) {
    await vault.modify(file, content);
    return;
  }
  try {
    await vault.create(normalized, content);
  } catch {
    const existing = vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) await vault.modify(existing, content);
  }
}

/** Atomic read-modify-write for an existing file; falls back for older API. */
export async function mutateFileAtomic(
  vault: Vault,
  path: string,
  mutate: (content: string) => string
): Promise<void> {
  const file = vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) throw new Error(`mutateFileAtomic: no file at ${path}`);
  const withProcess = vault as unknown as {
    process?: (path: string, fn: (data: string) => string) => Promise<string>;
  };
  if (typeof withProcess.process === "function") {
    await withProcess.process(file.path, mutate);
    return;
  }
  await vault.modify(file, mutate(await vault.read(file)));
}

export function inboxHeader(address: string): string {
  return (
    `# Inbox — ${address}\n\n` +
    "Append-only, oldest at top. Do not reorder or edit delivered blocks. See SPEC.md.\n\n"
  );
}

/**
 * Merge one entry into `<root>/registry.md`, byte-compatible with
 * obsidian-messenger's registry table (advisory directory, rewritten not
 * appended).
 */
export async function upsertRegistryEntry(
  vault: Vault,
  root: string,
  entry: RegistryEntry
): Promise<void> {
  if (!ADDRESS_RE.test(entry.address)) {
    throw new Error(`Invalid messenger address: ${entry.address}`);
  }
  const registryPath = normalizePath(`${root}/registry.md`);
  const entries = await readRegistry(vault, root);
  const next = [entry, ...entries.filter((e) => e.address !== entry.address)].sort((a, b) =>
    a.address.localeCompare(b.address)
  );
  const escape = (s: string): string => s.replace(/\|/g, "\\|");
  const table =
    "| address | name | updated |\n| --- | --- | --- |\n" +
    next
      .map((e) => `| ${escape(e.address)} | ${escape(e.name)} | ${escape(e.updated)} |`)
      .join("\n") +
    "\n";
  const content =
    "# Messenger registry\n\nWho lives on this bus. Advisory only — " +
    `any folder with an inbox.md is addressable. Rewritten by plugins, not appended.\n\n${table}`;
  await writeFile(vault, registryPath, content);
}

export async function readRegistry(vault: Vault, root: string): Promise<RegistryEntry[]> {
  const registryPath = normalizePath(`${root}/registry.md`);
  const file = vault.getAbstractFileByPath(registryPath);
  if (!(file instanceof TFile)) return [];
  const content = await vault.read(file);
  const entries: RegistryEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").map((c) => c.trim());
    // rows look like: | address | name | updated | → ["", address, name, updated, ""]
    if (cells.length < 5) continue;
    const address = cells[1];
    const name = cells[2];
    const updated = cells[3];
    if (!address || address === "---" || !ADDRESS_RE.test(address)) continue;
    entries.push({
      address,
      name: (name || address).replace(/\\\|/g, "|"),
      updated: updated.replace(/\\\|/g, "|"),
    });
  }
  return entries;
}
