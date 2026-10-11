# Capture targets — AI apps we can instrument

Research inventory (2026-10-11) of AI apps whose activity curtis-ai-audit
could record, and the mechanism for each. "Instrument" is the honest word:
every mechanism below requires the end user to install or configure
something. There is no silent adoption path, by design.

## The three mechanisms

| # | mechanism | target cooperation | data quality |
| - | --------- | ------------------ | ------------ |
| M1 | upstream PR: `if (window.curtisAudit) audit.record({...})` at the provider-call completion site | maintainer merges PR; user enables plugin | richest — agent, subject, status, tokens, timing |
| M2 | hooks/plugins the agent already supports, appending OM-1 blocks to `Messenger/audit/inbox.md` | user installs a vault-scoped config (usually one-time approval) | tool-level actions, cwd context; model/tokens may be missing |
| M3 | gateway projection: point a custom base URL at a local proxy that forwards and files receipts | user changes one setting | HTTP metadata only — no subject, weak attribution |

## Tier 1 — CLI agents with hook systems (M2, no code changes)

The big finding: the newest agent CLIs all grew hook systems in 2025–2026,
and most read **project-scoped** config. A vault can ship its own audit
hooks — the vault carries the instrument.

### Claude Code (Anthropic)
- Hooks: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`,
  `SubagentStart`/`SubagentStop`, `Stop`, `UserPromptSubmit`, and more.
- Config: `.claude/settings.json` in the project dir (vault-scoped),
  matched by event/tool; hook receives JSON on stdin (`session_id`,
  `tool_name`, `tool_input`, `cwd`, …) and may run a shell command.
- Project-level hooks require one-time user review/approval (security
  change after the 2025 hooks incident) — which fits the opt-in story.
- Receipt: a `PostToolUse` hook that appends one OM-1 block per tool call,
  `agent: "claude-code"`, action from `tool_name`. Verify exact stdin
  schema per version at build time (hook quirks are reported in issues).

### Gemini CLI (Google)
- Hooks added Jan/Feb 2026: `BeforeTool`, `AfterTool`, `BeforeAgent`,
  `SessionStart` (+ compact variant); JSON output with an explicit
  allow/deny decision. Config scoped via Gemini settings/extension model.
- Same receipt pattern as Claude Code; event names differ.

### OpenCode (sst → anomalyco)
- Plugin system (TS): `.opencode/plugin/*.js` in the project, hooks
  `tool.execute.before` / `tool.execute.after` plus a general `event`
  handler. SDK moved to `@opencode-ai/sdk/v2` in v1.1.x; some beta
  versions had `event.subscribe` regressions — pin versions.
- Strongest programmatic surface after Claude Code: full tool I/O in a
  real TS module, project-scoped.

### Codex CLI (OpenAI) — partial
- No per-tool hooks. `~/.codex/config.toml` has a top-level `notify`
  key: an external command invoked with a JSON payload on turn
  completion. `tui.notifications` is display-only.
- Verdict: turn-level receipts only (`action: "agent-turn"`). Still
  worth wiring — Claudian embeds Codex, so turn receipts cover it.

### Claudian (YishenTu/claudian) — the multiplier
- ~15.6k stars, MIT, actively developed (created Dec 2025). Embeds
  Claude Code / Codex / OpenCode / Grok in a vault sidebar.
- Every Claudian user is addressable through Tier 1: vault-scoped hook
  configs instrument the embedded agents with zero changes to Claudian.
- Also a good M1 target later (MIT, one optional `record()` call at its
  agent-completion sites).

## Tier 2 — Obsidian AI plugins (M1 upstream PRs)

| plugin | stars | license | notes |
| ------ | ----- | ------- | ----- |
| [Copilot](https://github.com/logancyang/obsidian-copilot) | ~7.8k | AGPL-3.0 | RAG chat; now also runs CLI agents (OpenCode/Codex/Claude Code) |
| [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) | ~5.5k | custom | embeddings + Smart Chat; local models common |
| [Text Generator](https://github.com/nhaouari/obsidian-textgenerator-plugin) | ~2.0k | MIT | multi-provider, community/template ecosystem |
| Smart Composer | — | MIT | repo not found at the expected path (possibly renamed/archived; development reportedly stalled) — re-verify |
| SystemSculpt AI | — | proprietary? | commercial suite; PR path unclear |
| BMO Chatbot ([longy2k](https://github.com/longy2k/obsidian-bmo-chatbot)) | ~1k | MIT | Ollama/LM Studio/OpenAI/Anthropic/Gemini |
| Local GPT ([pfrankov](https://github.com/pfrankov/obsidian-local-gpt)) | ~1k | — | routes through the AI Providers hub plugin — instrument the hub once, cover several plugins |
| ChatGPT-MD ([bramses](https://github.com/bramses/chatgpt-md)) | ~1k | — | conversations as markdown in the vault |

The pitch is exactly INTEGRATION.md Path A: fire-and-forget
`if (window.curtisAudit) audit.record({...})` after the response
settles — opt-in, zero-cost no-op when the audit plugin is absent.
Best first PRs: Text Generator (MIT, clean chokepoint), Copilot
(biggest chat base), Claudian. AI Providers is the leverage play:
one hook may cover multiple downstream plugins.

## Tier 3 — MCP servers (M2 with a patch, or a wrapper)

- Main vault servers: [mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian)
  (Python, via the Obsidian **Local REST API** plugin) and
  [obsidian-mcp](https://github.com/StevenStavrakis/obsidian-mcp)
  (TypeScript, direct filesystem). Many smaller forks/universal servers.
- Hosts (Claude Desktop, Cursor, Windsurf, Cline) expose **no** local
  event surface for tool use — instrumentation must live inside the
  server process: a fork/patch that appends a receipt after each tool
  call, installed by the user in `claude_desktop_config.json`.
- These are external processes with full vault write access — the exact
  audience Path B was designed for, but nothing forces them to report.
- Unverified: whether the Local REST API plugin's own request log could
  serve as a passive audit source. Worth a look.

## Tier 4 — gateway projection (M3, zero target cooperation)

- LiteLLM proxy: a `CustomLogger` subclass registered in
  `proxy_config.yaml` (`litellm_settings: callbacks`) can append one
  OM-1 receipt per request to the vault inbox. The user points any app
  with a configurable OpenAI-compatible base URL at the proxy.
- Covers the generic long tail (any OpenAI-compatible app) but is
  lossy: model/tokens/duration only, no subject, attribution limited
  to API key/model routing. Helicone (self-hosted) is observability
  with a Request API — a complement, not a file-append capture path.

## Honest limits

- Stars ≠ installs; numbers above are GitHub stars (checked 2026-10-11).
- Hook systems are young and version-sensitive (Claude Code hook quirks,
  OpenCode beta regressions). Receipt writers must be defensive and
  never break the agent's run — same rule as Path A.
- A configured target that omits or deletes receipts stays invisible;
  the ledger's verify catches tampering, not omission. Journal, not
  forensics — same caveat as SPEC §6, applied to the senders.

## Next tech steps

1. **Receipt-writer helper**: one tiny cross-platform script/binary a
   hook can call — takes JSON on stdin, appends a well-formed OM-1
   block to `Messenger/audit/inbox.md` (single atomic append, unique id).
2. **`curtis-audit hooks install` command** that writes the vault-scoped
   configs: `.claude/settings.json` hooks, `.opencode/plugin/curtis-audit.js`,
   Gemini settings, and a Codex `notify` recipe. This is the product.
3. Upstream PRs: Text Generator, Copilot, Claudian (in that order).
4. LiteLLM `CustomLogger` recipe in INTEGRATION.md.
5. Investigate the Local REST API request log as a passive source; if
   viable, MCP coverage arrives without patching any server.
