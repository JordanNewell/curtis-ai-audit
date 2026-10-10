# Curtis AI Audit

**Local-first audit trail for AI agent activity in your Obsidian vault.**
Every agent inference gets an append-only markdown receipt — a journal you
keep on your own agents, not a forensic system, and honest about the
difference (see [SPEC.md](./SPEC.md)).

Speaks [OM-1](../Obsiadian%20Messenger/SPEC.md) (Obsidian Messenger): agents,
other plugins, or a shell one-liner can all file receipts. The messenger
plugin is *not* required — the audit inbox is just a file.

## What it does

- **Receipts** — one `audit.v1` block per agent action: who, what, when,
  model, duration, tokens, status, plus a rendered human summary.
- **Per-day ledger** — append-only shards under `Audit/ledger/YYYY-MM-DD.md`.
  Envelope = the receipt as canonical JSON; body = the summary. Readable in
  Obsidian, parseable by anything.
- **Ingest** — polls the OM-1 audit inbox (`Messenger/audit/inbox.md`) with
  proper cursor semantics; junk is rejected, redeliveries are deduped.
- **Direct API** — in-process plugins can skip the bus:
  `window.curtisAudit.record({ agent, model, tokens, ... })`.
- **Verify** — detects malformed blocks, duplicate ids/sequences, reordered
  shards, and per-agent sequence gaps (deletions leave holes; no crypto, no
  false promises).
- **Digest** — a rolling `Audit/digest.md`: counts, statuses, tokens, errors.
- **Retention off by default** — an audit trail that silently ages out is a
  policy contradiction. Opt in if you want it.

## Install (dev)

Copy this folder into `<vault>/.obsidian/plugins/curtis-ai-audit/`, then
`npm install && npm run build`, and enable it in Obsidian.

## Usage

Ribbon icon or commands:

| command                 | what it does                                   |
| ----------------------- | ---------------------------------------------- |
| Check audit inbox now   | poll + ingest, with a summary notice           |
| Verify ledger           | integrity scan; details to console             |
| Write digest            | (re)write `Audit/digest.md` and open it        |
| Prune ledger now        | manual retention pass (needs retention > 0)    |
| Open today's ledger     | open/create today's shard                      |

Other plugins (same window):

```ts
const receipt = await window.curtisAudit.record({
  agent: "curtis-ai-chat",
  action: "inference",          // optional, default "other"
  model: "gpt-4o",
  provider: "openai",
  durationMs: 1234,
  tokens: { input: 812, output: 341 },
  subject: "Notes/question.md",
  summary: "Answered a question about the spec",
});
// also: .poll(), .verify(), .digest(days?)
// workspace event: "curtis-audit:receipt"
```

Anything that can append to a file (other device, script, agent):

```
<!-- messenger: {"id":"msg_x","from":"research-agent","to":"audit","ts":"2026-10-10T12:00:00.000Z","replyTo":null} -->
{"action":"inference","model":"gemini-2.5-pro","summary":"Summarized a paper"}
<!-- /messenger -->
```

See [INTEGRATION.md](./INTEGRATION.md) for wiring up `curtis-ai-chat`.

## Testing

```
npm test        # 58 unit tests, in-memory vault, no Obsidian needed
npm run build   # typecheck + bundle to main.js
```

## Status

v0.1.0 — the local-first tier, deliberately. Tamper-evidence, retention
enforcement, and reporting are the next tier up and are not pretended here.
