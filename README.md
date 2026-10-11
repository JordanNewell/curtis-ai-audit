<div align="center">
  <img src="assets/curtis-ai-logo.svg" width="110" alt="Curtis AI Audit — green C ring with a check">
</div>

# Curtis AI Audit

**Local-first audit trail for AI agent activity in your Obsidian vault.**
Every agent inference gets an append-only markdown receipt — a journal you
keep on your own agents, not a forensic system, and honest about the
difference (see [SPEC.md](./SPEC.md)).

Speaks OM-1 (Obsidian Messenger): agents,
other plugins, or a shell one-liner can all file receipts — see
[INTEGRATION.md](./INTEGRATION.md). The messenger
plugin is *not* required — the audit inbox is just a file.

## What it does

- **Receipts** — one `audit.v1` block per agent action: who, what, when,
  model, duration, tokens, status, plus a rendered human summary.
- **Per-day ledger** — append-only shards under `Audit/ledger/YYYY-MM-DD.md`.
  Envelope = the receipt as canonical JSON; body = the summary. Readable in
  Obsidian, parseable by anything.
- **Ingest** — polls the OM-1 audit inbox (`Messenger/audit/inbox.md`) with
  proper cursor semantics; junk is rejected, redeliveries are deduped.
- **Agent hooks** — `Install agent audit hooks` writes vault-scoped configs
  (Claude Code, OpenCode) so local agents file their own receipts through the
  bundled writer (`bin/curtis-audit-file.mjs`); Codex and Gemini get manual
  recipes. Metadata only — tool input content is never recorded. Source
  installs only: the writer ships with the repo, not with plugin releases
  (Paths A and B work everywhere).
- **Direct API** — in-process plugins can skip the bus:
  `window.curtisAudit.record({ agent, model, tokens, ... })`.
- **Query** — the read side: `window.curtisAudit.query({ agent, status,
  since, ... })` for status bars, dashboards, and other plugins.
- **Verify** — detects malformed blocks, duplicate ids/sequences, reordered
  shards, and per-agent sequence gaps (deletions leave holes; no crypto, no
  false promises).
- **Digest** — a rolling `Audit/digest.md`: counts, statuses, tokens,
  durations, a per-day breakdown, errors.
- **Retention off by default** — an audit trail that silently ages out is a
  policy contradiction. Opt in if you want it; each prune is itself recorded
  as a receipt, so the gaps it leaves are self-explaining.

## Install

From a [release](../../releases): download `main.js`, `manifest.json`, and
`styles.css` into `<vault>/.obsidian/plugins/curtis-ai-audit/`, then enable
the plugin in Obsidian (Settings → Community plugins). Once accepted into the
community directory it installs from there directly.

From source: clone this repo into
`<vault>/.obsidian/plugins/curtis-ai-audit/`, run
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
| Install agent audit hooks  | write vault-scoped hook configs (Path C)    |
| Uninstall agent audit hooks | remove exactly what install added           |

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
// also: .poll(), .verify(), .digest(days?), .query(filter)
// workspace event: "curtis-audit:receipt"
```

The read side, for dashboards and status bars:

```ts
const errors = await window.curtisAudit.query({
  agent: "curtis-ai-chat",
  status: "error",
  since: "2026-10-01",   // bounds apply to `recorded` (local write time)
  order: "desc",         // newest first (the default)
  limit: 20,
});
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
npm test        # 107 unit tests, in-memory vault, no Obsidian needed
npm run build   # typecheck + bundle to main.js
```

## Status

v0.2.1 — the local-first tier, deliberately. Tamper-evidence, retention
enforcement, and reporting are the next tier up and are not pretended here.

## License

[MIT](./LICENSE) © Jordan Newell
