# Integrating agents with Curtis AI Audit

Three paths, pick by where the agent runs.

## Path A — in-Obsidian plugins (curtis-ai-chat, other plugins)

The direct API. One call at the chokepoint where your plugin already knows
the request and response. For curtis-ai-chat that is the provider-call
completion site — the same place that already has model, timing, token
usage, and the finish status:

```ts
// after the provider response settles (success, error, or abort):
const audit = window.curtisAudit;
if (audit) {
  audit.record({
    agent: "curtis-ai-chat",
    action: "inference",
    status: finished ? "ok" : aborted ? "aborted" : "error",
    provider,            // e.g. "openai", "deepseek" — you already track this
    model,               // the resolved model id
    durationMs,          // wall clock around the request
    tokens: usage ? { input: usage.prompt_tokens, output: usage.completion_tokens } : undefined,
    subject: activeNotePath,          // optional: the note in play
    summary: firstLineOfUserPrompt,   // keep it short; see privacy note below
  }).catch((err) => console.warn("[curtis-ai-chat] audit failed", err));
}
```

Rules that keep this cheap and safe:

- **Never block or fail the inference path.** Audit failures are logged, not
  thrown. `record()` rejects on invalid payloads — that means your call site
  has a bug, not the user a problem.
- `record()` requires `agent`. One address per plugin (OM-1 §2: use your
  plugin id).
- Fire-and-forget is fine; the ledger serializes sequence numbers itself.

### Multi-agent plugins

If your plugin orchestrates sub-agents, give each an address and pass it in
the payload (`agent: "research-agent"`); sequence series are per agent, so
their histories stay independent.

## Path B — external agents, scripts, other devices

Append an OM-1 message to the audit inbox. No plugin API, no network — if
you can write to the vault, you can file receipts. The message body is the
payload as JSON; everything except `id`, `seq`, `recorded` may be included,
and `agent` defaults to the sender address.

```
<!-- messenger: {"id":"msg_k9x2ab","from":"research-agent","to":"audit","ts":"2026-10-10T12:00:00.000Z","replyTo":null} -->
{"action":"tool-call","model":"gemini-2.5-pro","status":"ok","summary":"Ran a vault search"}
<!-- /messenger -->
```

From a shell (vault at `~/vault`):

```bash
append_receipt() {
  to="$1"; from="$2"; body="$3"
  id="msg_$(date +%s | tr -d '\n')$$"
  ts="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  printf '<!-- messenger: {"id":"%s","from":"%s","to":"%s","ts":"%s","replyTo":null} -->\n%s\n<!-- /messenger -->\n\n' \
    "$id" "$from" "$to" "$ts" "$body" >> "~/vault/Messenger/audit/inbox.md"
}
append_receipt audit research-agent '{"action":"inference","summary":"Nightly digest run"}'
```

Notes:

- Appending must be a single atomic write (one `>>`). Never edit delivered
  blocks; the ledger's cursor assumes append-only inboxes (OM-1 §3).
- Ids must be unique per sender; `msg_` + time + something random works.
- If the messenger plugin is installed, its `window.obsidianMessenger`
  client API works too — same inbox, same format.

## Path C — local agents via hooks (installed by the plugin)

Claude Code, OpenCode, Codex and Gemini all grew hook/event systems. The
`Install agent audit hooks` command writes vault-scoped configs that make
them file receipts through the bundled writer `bin/curtis-audit-file.mjs`
(JSON on stdin → one OM-1 block appended to the audit inbox; always exits 0,
never breaks the agent's run).

- **Claude Code** — merges a `PostToolUse` (per tool call) and a `Stop`
  (per turn, `action: "agent-turn"`) entry into `.claude/settings.json`;
  unrelated config is preserved, a second install is a no-op. Project hooks
  require one-time user approval via `/hooks` — by design.
- **OpenCode** — writes `.opencode/plugin/curtis-audit.js`, a generated
  plugin that spawns the writer after each tool call. Best-effort payload
  mapping (OpenCode's hook shape is still settling).
- **Codex CLI** — manual: add the `notify` line printed by the command to
  user-scoped `~/.codex/config.toml`. Turn-level receipts only.
- **Gemini CLI** — manual for now: its hook schema is still settling; the
  command prints the recipe.

Uninstall removes exactly what install added (entries are tagged by the
writer filename) and touches nothing else. Malformed existing JSON aborts
that target untouched.

**Privacy rule, enforced in the writer:** only the tool name and path-like
fields (file paths, URLs) reach the ledger. Command text, prompt text, and
note contents are dropped at the source — see the privacy posture below.

## Privacy posture

The ledger records what the *caller* puts in it. Recommended posture for a
personal journal: metadata always (model, duration, tokens, status, subject
path), content sparingly (a one-line summary, not the full prompt), full
payloads only when you actually need them and accept that they live in a
plaintext vault. The `detail` field exists for the cases where you do.

## What you get back

- `Audit/ledger/YYYY-MM-DD.md` — the receipts, human-readable in Obsidian.
- `window.curtisAudit.query({ agent, status, since, ... })` — the read side,
  for status bars and dashboards: filters by agent/action/status/model/
  subject prefix, bounds on `recorded`, `order` + `limit`.
- `Verify ledger` — catches malformed blocks, duplicates, reordering, and
  deletions (sequence gaps), honestly scoped: it detects the casual cases,
  it does not defeat a determined editor (SPEC §6).
- `Audit/digest.md` — counts, statuses, tokens, durations, a per-day
  breakdown, recent errors.
- `curtis-audit:receipt` workspace event after every written receipt.
