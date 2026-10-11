/**
 * Vault-scoped agent hook configs (INTEGRATION.md Path C): the plugin writes
 * the configs that make local agents file receipts to the audit inbox through
 * bin/curtis-audit-file.mjs. Pure builders live here; main.ts binds them to
 * the vault adapter.
 *
 * Rules:
 *  - Merge, never clobber. Unrelated keys and other hooks survive; a second
 *    install is a no-op; uninstall removes exactly what install added
 *    (entries are tagged by the writer filename).
 *  - Malformed existing JSON aborts that target untouched.
 *  - Only vault-scoped, well-documented schemas are written automatically
 *    (Claude Code settings, a fresh OpenCode plugin file). Anything user-
 *    scoped or schema-unverified (Codex config.toml, Gemini hooks) is
 *    surfaced as manual instructions instead.
 */

export const WRITER_MARKER = "curtis-audit-file.mjs";

export interface HookIo {
  /** Returns null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
}

export type HookAction =
  | "added"
  | "updated"
  | "already-installed"
  | "removed"
  | "manual"
  | "aborted";

export interface HookTargetResult {
  target: string;
  path?: string;
  action: HookAction;
  detail?: string;
}

const CLAUDE_SETTINGS = ".claude/settings.json";
const OPENCODE_PLUGIN = ".opencode/plugin/curtis-audit.js";

/** Shell command that runs the writer; embedded verbatim inside hook configs. */
export function writerCommand(
  writerPath: string,
  inboxPath: string,
  agent: string,
  extra: string[] = []
): string {
  const args = ["--agent", agent, "--inbox", inboxPath, ...extra];
  // Quote only tokens that need it: flags, addresses, and simple values go
  // bare; anything with separators or whitespace (i.e. paths) does not.
  const q = (a: string): string => (/^[\w.=-]+$/.test(a) ? a : `"${a}"`);
  return `node ${q(writerPath)} ${args.map(q).join(" ")}`;
}

const isOurEntry = (entry: unknown): boolean =>
  JSON.stringify(entry).includes(WRITER_MARKER);

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

/**
 * Adds our PostToolUse + Stop entries to a parsed .claude/settings.json.
 * Idempotent: a second call adds nothing.
 */
export function buildClaudeHooks(
  existing: unknown,
  writerPath: string,
  inboxPath: string
): { config: Record<string, unknown>; added: string[] } {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("settings.json is not an object");
  }
  const config = structuredClone(existing) as Record<string, unknown>;
  const hooks = (config.hooks ??= {}) as Record<string, unknown>;
  const added: string[] = [];

  const ensure = (event: string, entry: HookEntry, label: string): void => {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (!list.some(isOurEntry)) {
      hooks[event] = [...list, entry];
      added.push(label);
    }
  };
  ensure(
    "PostToolUse",
    {
      matcher: "*",
      hooks: [{ type: "command", command: writerCommand(writerPath, inboxPath, "claude-code") }],
    },
    "claude-code PostToolUse"
  );
  ensure(
    "Stop",
    {
      hooks: [
        {
          type: "command",
          command: writerCommand(writerPath, inboxPath, "claude-code", ["--action", "agent-turn"]),
        },
      ],
    },
    "claude-code Stop"
  );

  return { config, added };
}

/** Removes only entries tagged with our writer marker; preserves everything else. */
export function removeClaudeHooks(
  existing: unknown
): { config: Record<string, unknown>; removed: string[] } {
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new Error("settings.json is not an object");
  }
  const config = structuredClone(existing) as Record<string, unknown>;
  const removed: string[] = [];
  const hooks = config.hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    const container = hooks as Record<string, unknown>;
    for (const event of Object.keys(container)) {
      const list = container[event];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((entry) => {
        if (isOurEntry(entry)) {
          removed.push(`claude-code ${event}`);
          return false;
        }
        return true;
      });
      if (kept.length === 0) delete container[event];
      else container[event] = kept;
    }
    if (Object.keys(container).length === 0) delete config.hooks;
  }
  return { config, removed };
}

/**
 * Generated OpenCode plugin: forwards tool activity to the writer. Spawned
 * per tool call, never throwing into the agent's run. Best-effort payload
 * mapping — OpenCode's hook payload shape is still settling; only the tool
 * name and path-like metadata are read.
 */
export function buildOpencodePluginSource(writerPath: string, inboxPath: string): string {
  const writer = JSON.stringify(writerPath);
  const inbox = JSON.stringify(inboxPath);
  return `// Generated by curtis-ai-audit — safe to delete; reinstall re-creates it.
// Forwards OpenCode tool activity to the Curtis AI Audit inbox (INTEGRATION.md
// Path C). Only the tool name and path-like metadata are read; payload content
// is never recorded. Hook payload shape is best-effort — verify against your
// OpenCode version if receipts look wrong.
const WRITER = ${writer};
const INBOX = ${inbox};

export async function CurtisAuditHooks() {
  const { spawn } = await import("node:child_process");
  return {
    "tool.execute.after": async (input, output) => {
      try {
        const metadata = output?.metadata ?? {};
        const payload = {
          tool_name: input?.tool ?? input?.toolName,
          tool_input: {
            file_path: metadata.filePath ?? metadata.file ?? undefined,
            path: metadata.path ?? undefined,
          },
        };
        const child = spawn(process.execPath, [WRITER, "--agent", "opencode", "--inbox", INBOX], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(payload));
        child.unref?.();
      } catch {
        // never break the agent's tool call
      }
    },
  };
}

export default CurtisAuditHooks;
`;
}

export function codexNotifyInstructions(writerPath: string, inboxPath: string): string {
  return (
    "Codex CLI (manual, user-scoped ~/.codex/config.toml):\n" +
    `  notify = ["node", "${writerPath}", "--agent", "codex", "--inbox", "${inboxPath}", "--action", "agent-turn"]\n` +
    "  Turn-level receipts only; Codex passes the payload as an argv JSON string."
  );
}

export function geminiInstructions(writerPath: string, inboxPath: string): string {
  return (
    "Gemini CLI (manual — hook schema still settling, not auto-written):\n" +
    `  AfterTool hook → node "${writerPath}" --agent gemini --inbox "${inboxPath}"\n` +
    "  See TARGETS.md and your Gemini CLI version's hooks docs."
  );
}

async function readJson(io: HookIo, path: string): Promise<unknown> {
  const content = await io.readText(path);
  if (content === null) return "missing";
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return "malformed";
  }
}

export async function installAgentHooks(
  io: HookIo,
  opts: { writerPath: string; inboxPath: string }
): Promise<HookTargetResult[]> {
  const { writerPath, inboxPath } = opts;
  const results: HookTargetResult[] = [];

  // Claude Code — merge into existing settings.json.
  const existing = await readJson(io, CLAUDE_SETTINGS);
  if (existing === "malformed") {
    results.push({
      target: "claude-code",
      path: CLAUDE_SETTINGS,
      action: "aborted",
      detail: "existing settings.json is not valid JSON — left untouched",
    });
  } else {
    const base = existing === "missing" ? {} : existing;
    const { config, added } = buildClaudeHooks(base, writerPath, inboxPath);
    if (added.length === 0) {
      results.push({ target: "claude-code", path: CLAUDE_SETTINGS, action: "already-installed" });
    } else {
      await io.writeText(CLAUDE_SETTINGS, JSON.stringify(config, null, 2) + "\n");
      results.push({
        target: "claude-code",
        path: CLAUDE_SETTINGS,
        action: existing === "missing" ? "added" : "updated",
        detail: added.join(", "),
      });
    }
  }

  // OpenCode — additive plugin file; abort on a foreign file with the same name.
  const opencodeExisting = await io.readText(OPENCODE_PLUGIN);
  if (opencodeExisting !== null && !opencodeExisting.includes("Generated by curtis-ai-audit")) {
    results.push({
      target: "opencode",
      path: OPENCODE_PLUGIN,
      action: "aborted",
      detail: "a file we did not generate already exists there — left untouched",
    });
  } else {
    await io.writeText(OPENCODE_PLUGIN, buildOpencodePluginSource(writerPath, inboxPath));
    results.push({
      target: "opencode",
      path: OPENCODE_PLUGIN,
      action: opencodeExisting === null ? "added" : "updated",
    });
  }

  // Codex + Gemini are user-scoped or schema-unverified: instructions only.
  results.push({
    target: "codex",
    action: "manual",
    detail: codexNotifyInstructions(writerPath, inboxPath),
  });
  results.push({
    target: "gemini",
    action: "manual",
    detail: geminiInstructions(writerPath, inboxPath),
  });

  return results;
}

export async function uninstallAgentHooks(io: HookIo): Promise<HookTargetResult[]> {
  const results: HookTargetResult[] = [];

  const claude = await readJson(io, CLAUDE_SETTINGS);
  if (claude === "missing") {
    results.push({ target: "claude-code", path: CLAUDE_SETTINGS, action: "already-installed" });
  } else if (claude === "malformed") {
    results.push({
      target: "claude-code",
      path: CLAUDE_SETTINGS,
      action: "aborted",
      detail: "settings.json is not valid JSON — left untouched",
    });
  } else {
    const { config, removed } = removeClaudeHooks(claude);
    if (removed.length === 0) {
      results.push({ target: "claude-code", path: CLAUDE_SETTINGS, action: "already-installed" });
    } else {
      await io.writeText(CLAUDE_SETTINGS, JSON.stringify(config, null, 2) + "\n");
      results.push({
        target: "claude-code",
        path: CLAUDE_SETTINGS,
        action: "removed",
        detail: removed.join(", "),
      });
    }
  }

  const opencode = await io.readText(OPENCODE_PLUGIN);
  if (opencode === null) {
    results.push({ target: "opencode", path: OPENCODE_PLUGIN, action: "already-installed" });
  } else if (!opencode.includes("Generated by curtis-ai-audit")) {
    results.push({
      target: "opencode",
      path: OPENCODE_PLUGIN,
      action: "aborted",
      detail: "not ours — left untouched",
    });
  } else {
    await io.writeText(OPENCODE_PLUGIN, "");
    results.push({ target: "opencode", path: OPENCODE_PLUGIN, action: "removed" });
  }

  return results;
}
