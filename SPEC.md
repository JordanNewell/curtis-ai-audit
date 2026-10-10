# Curtis AI Audit — Ledger Spec (audit.v1)

A **local-first accountability journal** for AI agent activity in an Obsidian
vault. Every agent action — usually one LLM inference — gets an append-only
markdown receipt in the vault.

**What this is not:** a forensic audit system. There is no cryptography, no
completeness proof, and no third-party verifiability. The user controls the
vault, so the user can edit anything; what the ledger provides is *residue* —
edits and deletions leave detectable traces (see §6). If you need a log a
third party can be asked to believe, that is a different-sized project; §8
describes the upgrade path.

Works standalone or alongside the [Obsidian Messenger](../Obsiadian%20Messenger)
plugin (OM-1 protocol). The block format is byte-compatible with OM-1's
envelope rules, so the same parsing discipline applies.

## 1. Storage layout

```
Audit/                    (configurable, default "Audit")
  ledger/
    2026-10-10.md         one append-only shard per day (by recorded date)
  state.json              per-agent seq high-water marks (derived, rebuildable)
  digest.md               human-readable rolling digest (rewritten)
Messenger/audit/inbox.md  the OM-1 inbox senders append receipts to
                          (lives under the messenger root; optional)
```

Ledger shards are **append-only**: never reorder, edit, or delete a block —
except pruning (§7), which rewrites whole shards and is reported by verify.

## 2. Receipts (schema audit.v1)

One agent action, one receipt. The envelope of a ledger block is the whole
receipt as **canonical JSON** (sorted keys, no whitespace, single line —
stable input for any future hash chain).

| field        | type                | notes                                             |
| ------------ | ------------------- | ------------------------------------------------- |
| `schema`     | `"audit.v1"`        | versioned from day one                            |
| `id`         | string              | `rcp_` + base36 time + random; unique per receipt |
| `seq`        | integer ≥ 0         | per-agent sequence, assigned by the ledger (§5)   |
| `agent`      | address             | OM-1 address of the agent (§2 of OM-1 SPEC)       |
| `ts`         | ISO 8601 UTC        | when the action happened                          |
| `recorded`   | ISO 8601 UTC        | when the receipt was written                      |
| `action`     | string              | open vocabulary, `[a-z0-9._-]`: `inference`, `tool-call`, `note-write`, … default `other` |
| `status`     | `ok`/`error`/`aborted` | default `ok`                                   |
| `provider`   | string?             | e.g. `openai`, `deepseek`                         |
| `model`      | string?             | e.g. `gpt-4o`                                     |
| `durationMs` | number?             | wall-clock duration                               |
| `tokens`     | object?             | `{ input?, output? }` non-negative numbers        |
| `subject`    | string?             | vault path or object the action was about         |
| `summary`    | string?             | one human-readable line                           |
| `sourceId`   | string?             | OM-1 message id when ingested from the bus        |
| `detail`     | any?                | caller-defined; must be JSON-serializable         |

`ts` ≠ `recorded` on purpose: `ts` is the sender's claim about the action,
`recorded` is the local fact about the write. Shard placement follows
`recorded`.

## 3. Ledger blocks

```
<!-- curtis-audit: {"action":"inference","agent":"curtis-ai-chat",...} -->
**inference** · ok · `gpt-4o` via `openai` · 1234ms · 100 in / 50 out
Subject: `Notes/question.md`

Answered a question
<!-- /curtis-audit -->
```

- Envelope: the receipt, canonical JSON, one line. Comment tokens (`-->`,
  `<!--`) inside string values are escaped as JSON unicode escapes
  (`\u003e`, `\u003c`) so the HTML comment can never terminate early;
  parsed values are unchanged.
- Body: rendered summary, with comment tokens escaped so a body can never
  swallow the closing marker.
- The `curtis-audit:` marker is distinct from the bus's `messenger:` marker;
  parsers ignore each other's blocks.

## 4. Ingest

The audit inbox `<messengerRoot>/<inboxAddress>/inbox.md` (default
`Messenger/audit/inbox.md`) is a normal OM-1 inbox. Any participant that can
append to a file can file a receipt: the message body is the JSON payload
(everything except `id`, `seq`, `recorded`; `agent` defaults to the message's
`from`).

- Poll on a time-gated loop (default every 10s) and on demand.
- Cursors are receiver-local state, persisted after each pass, with the
  OM-1 id-then-timestamp fallback (OM-1 SPEC §4).
- Delivery is **at-least-once**; redelivery is detected via `sourceId` and
  counted as duplicates, not written twice. The dedupe check covers recent
  shards — the realistic crash window between ledger append and cursor save.
- Bodies that are not valid audit.v1 payloads are **rejected, not recorded**:
  junk never enters the ledger, and the cursor still advances.

Direct (in-process) recording skips the bus entirely:
`window.curtisAudit.record({ agent: "curtis-ai-chat", ... })`. Every written
receipt also emits a `curtis-audit:receipt` workspace event.

## 5. Sequence numbers

`claimSeq(agent)` hands out a monotonic per-agent integer across all shards.
It is assigned **by the ledger at write time** — senders cannot forge or
skip numbers. This is what makes deletions visible: within the range of seq
numbers present for an agent, every hole means a receipt existed (or a write
failed) and is no longer there.

High-water marks live in `state.json` (rewritten, derived state). If it is
lost or corrupt, the ledger rebuilds it by scanning the shards.

## 6. Verify

`Verify ledger` (command or `window.curtisAudit.verify()`) scans all shards
and reports:

| check                              | severity | meaning                                        |
| ---------------------------------- | -------- | ---------------------------------------------- |
| unparseable/invalid blocks         | warning  | truncated write, or hand-editing gone wrong    |
| duplicate receipt `id`             | error    | a receipt was duplicated                       |
| duplicate `(agent, seq)`           | error    | forged or copied sequence numbers              |
| out-of-`recorded`-order in a shard | warning  | the file was reordered/merged by something     |
| per-agent seq gaps                 | warning  | deletions, failed writes, or pruning (§7)      |

**Limits, stated plainly:** none of this proves the ledger is complete or
correct. A careful editor who also renumbers `seq`s defeats it. It detects
the casual, accidental, and lazy cases — which for a personal journal is the
point.

## 7. Retention

Retention is **off by default (0 = keep forever)** — an audit trail that
silently ages out is a policy contradiction. When enabled, old receipts are
pruned by rewriting/deleting whole shards. Pruning intentionally creates seq
gaps; verify reports them as warnings with that caveat. Whole-shard deletion
also means "history before the earliest remaining shard" is unknowable —
the gaps-before-min-seq are not enumerated.

## 8. Upgrade path (deliberately unbuilt)

- **Hash chaining:** each receipt's canonical envelope is already a stable
  byte string; a `prevHash`/`hash` pair can be layered on as `audit.v2`
  without reformatting history.
- **Anchoring:** periodic root hashes could be committed outside the vault
  (git, printed, etc.).
- Those belong to the "industry" tier (tamper evidence, retention policy
  enforcement, reporting). This repo is the layer below, and says so.
