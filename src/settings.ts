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
  const cleaned = value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .trim();
  return cleaned || fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeSettings(raw: Partial<AuditSettings> | null | undefined): AuditSettings {
  const s = raw ?? {};
  return {
    root: cleanPath(s.root, DEFAULT_SETTINGS.root),
    messengerRoot:
      typeof s.messengerRoot === "string"
        ? s.messengerRoot
            .replace(/\\/g, "/")
            .replace(/\/{2,}/g, "/")
            .replace(/^\/+|\/+$/g, "")
            .trim()
        : DEFAULT_SETTINGS.messengerRoot,
    inboxAddress:
      typeof s.inboxAddress === "string" && ADDRESS_RE.test(s.inboxAddress)
        ? s.inboxAddress
        : DEFAULT_SETTINGS.inboxAddress,
    pollSeconds: clamp(Math.floor(Number(s.pollSeconds) || DEFAULT_SETTINGS.pollSeconds), 1, 3600),
    retentionDays: clamp(Math.floor(Number(s.retentionDays) || 0), 0, 36500),
    debug: Boolean(s.debug),
    cursors: s.cursors && typeof s.cursors === "object" ? s.cursors : {},
  };
}
