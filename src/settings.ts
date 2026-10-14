/*
 * Curtis AI Audit — Copyright © 2026 Jordan Newell. All rights reserved.
 * SPDX-License-Identifier: BUSL-1.1
 * Noncommercial production use permitted; commercial use requires a written
 * license from the author. This license converts to MIT at the Change Date —
 * full terms in LICENSE (https://mariadb.com/bsl11/).
 */

import { ADDRESS_RE } from "./protocol";
import { Cursor } from "./ingest";

export interface AuditSettings {
  /** Vault folder holding the ledger, state, and digest. */
  root: string;
  /** Messenger root to watch for the audit inbox. Empty = bus integration off. */
  messengerRoot: string;
  /** Address of the audit inbox under the messenger root. */
  inboxAddress: string;
  /** Inbox poll interval, seconds. */
  pollSeconds: number;
  /** Days to keep receipts. 0 = keep forever (the default, deliberately). */
  retentionDays: number;
  debug: boolean;
  /** Ingest cursors, keyed by inbox path. Receiver-local state (OM-1 §4). */
  cursors: Record<string, Cursor>;
}

export const DEFAULT_SETTINGS: AuditSettings = {
  root: "Audit",
  messengerRoot: "Messenger",
  inboxAddress: "audit",
  pollSeconds: 10,
  retentionDays: 0,
  debug: false,
  cursors: {},
};

function cleanPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // trim first so trailing whitespace cannot protect a trailing separator
  const cleaned = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return cleaned || fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeSettings(raw: Partial<AuditSettings> | null | undefined): AuditSettings {
  const s = raw ?? {};
  return {
    root: cleanPath(s.root, DEFAULT_SETTINGS.root),
    // same cleaning as root, but a non-string falls back to the default
    // while a string that cleans to nothing stays "" (bus integration off)
    messengerRoot:
      typeof s.messengerRoot === "string"
        ? cleanPath(s.messengerRoot, "")
        : DEFAULT_SETTINGS.messengerRoot,
    inboxAddress:
      typeof s.inboxAddress === "string" && ADDRESS_RE.test(s.inboxAddress)
        ? s.inboxAddress
        : DEFAULT_SETTINGS.inboxAddress,
    // fractional input floors like retentionDays (1.9 → 1); a fraction below
    // the minimum (0.5) lands on the clamp floor of 1 rather than falling
    // back to the default — only falsy input takes the default
    pollSeconds: clamp(Math.floor(Number(s.pollSeconds) || DEFAULT_SETTINGS.pollSeconds), 1, 3600),
    retentionDays: clamp(Math.floor(Number(s.retentionDays) || 0), 0, 36500),
    debug: Boolean(s.debug),
    cursors: s.cursors && typeof s.cursors === "object" ? s.cursors : {},
  };
}
