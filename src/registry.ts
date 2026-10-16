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
  } catch (err) {
    // create can lose a race: another writer made the file between our
    // exists-check and create — write to it. Anything else is a real failure;
    // dropping the write silently would lose ledger/state updates.
    const existing = vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await vault.modify(existing, content);
      return;
    }
    throw err;
  }
}

/** Atomic read-modify-write for an existing file; falls back for older API.
 * Vault.process takes a TFile, not a path string — passing a string survives
 * the duck-type check but throws at runtime (Obsidian 1.14 assigns options on
 * the argument), and the modify fallback below would never run. */
export async function mutateFileAtomic(
  vault: Vault,
  path: string,
  mutate: (content: string) => string
): Promise<void> {
  const file = vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) throw new Error(`mutateFileAtomic: no file at ${path}`);
  const withProcess = vault as unknown as {
    process?: (file: TFile, fn: (data: string) => string) => Promise<string>;
  };
  if (typeof withProcess.process === "function") {
    await withProcess.process(file, mutate);
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

/** The literal header row cells written above every registry table. */
const HEADER_CELLS = ["address", "name", "updated"];

/**
 * Splits a table row on unescaped pipes only and unescapes each cell, so
 * values containing `\|` survive a write/read round trip.
 */
function splitRow(row: string): string[] {
  return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
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
  // Self-heal: drop phantom header rows and other junk an older build may
  // have persisted as data (the literal "address" passes ADDRESS_RE, and any
  // entry failing the regex has no business in the table).
  const entries = (await readRegistry(vault, root)).filter(
    (e) => e.address !== "address" && ADDRESS_RE.test(e.address)
  );
  const next = [entry, ...entries.filter((e) => e.address !== entry.address)].sort((a, b) =>
    a.address.localeCompare(b.address)
  );
  // escape pipes that are not already escaped — rewriting an entry that came
  // off disk must not double-escape it
  const escape = (s: string): string => s.replace(/(?<!\\)\|/g, "\\|");
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
    const cells = splitRow(trimmed);
    // rows look like: | address | name | updated | → ["", address, name, updated, ""]
    if (cells.length < 5) continue;
    const address = cells[1];
    const name = cells[2];
    const updated = cells[3];
    // the header row itself (and its old phantom persistence) is not data
    if (address === HEADER_CELLS[0] && name === HEADER_CELLS[1] && updated === HEADER_CELLS[2]) {
      continue;
    }
    if (!address || address === "---" || !ADDRESS_RE.test(address)) continue;
    entries.push({ address, name: name || address, updated });
  }
  return entries;
}
