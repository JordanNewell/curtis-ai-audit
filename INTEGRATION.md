# Integrating agents with Curtis AI Audit

Two paths, pick by where the agent runs.

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

## Privacy posture

The ledger records what the *caller* puts in it. Recommended posture for a
personal journal: metadata always (model, duration, tokens, status, subject
path), content sparingly (a one-line summary, not the full prompt), full
payloads only when you actually need them and accept that they live in a
plaintext vault. The `detail` field exists for the cases where you do.

## What you get back

- `Audit/ledger/YYYY-MM-DD.md` — the receipts, human-readable in Obsidian.
- `Verify ledger` — catches malformed blocks, duplicates, reordering, and
  deletions (sequence gaps), honestly scoped: it detects the casual cases,
  it does not defeat a determined editor (SPEC §6).
- `Audit/digest.md` — counts, statuses, tokens, recent errors.
- `curtis-audit:receipt` workspace event after every written receipt.
