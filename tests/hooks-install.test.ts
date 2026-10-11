import { describe, expect, it } from "vitest";
import {
  HookIo,
  HookTargetResult,
  buildClaudeHooks,
  buildOpencodePluginSource,
  installAgentHooks,
  removeClaudeHooks,
  uninstallAgentHooks,
  writerCommand,
} from "../src/hooks-install";

/** In-memory HookIo; every path is a plain vault-relative path. */
function makeIo(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const io: HookIo = {
    readText: async (p) => files.get(p) ?? null,
    writeText: async (p, content) => void files.set(p, content),
  };
  return { io, files };
}

const WRITER = "C:/vault/.obsidian/plugins/curtis-ai-audit/bin/curtis-audit-file.mjs";
const INBOX = "C:/vault/Messenger/audit/inbox.md";

describe("writerCommand", () => {
  it("quotes only path-like tokens, leaves flags bare", () => {
    expect(writerCommand(WRITER, INBOX, "claude-code", ["--action", "agent-turn"])).toBe(
      `node "${WRITER}" --agent claude-code --inbox "${INBOX}" --action agent-turn`
    );
  });
});

describe("buildClaudeHooks", () => {
  it("adds PostToolUse and Stop entries without touching unrelated keys", () => {
    const existing = {
      model: "opus",
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] },
        ],
      },
    };
    const { config, added } = buildClaudeHooks(existing, WRITER, INBOX);
    expect(added).toEqual(["claude-code PostToolUse", "claude-code Stop"]);
    expect(config.model).toBe("opus");
    const post = config.hooks.PostToolUse as unknown[];
    expect(post).toHaveLength(2);
    expect(JSON.stringify(post[0])).toContain("echo mine");
    expect(JSON.stringify(post[1])).toContain("curtis-audit-file.mjs");
  });

  it("is idempotent — a second install adds nothing", () => {
    const first = buildClaudeHooks({}, WRITER, INBOX);
    const second = buildClaudeHooks(first.config, WRITER, INBOX);
    expect(second.added).toEqual([]);
  });

  it("does not mutate the input object", () => {
    const existing = { hooks: {} };
    buildClaudeHooks(existing, WRITER, INBOX);
    expect(existing.hooks).toEqual({});
  });

  it("rejects non-object settings", () => {
    expect(() => buildClaudeHooks([1, 2], WRITER, INBOX)).toThrow(/not an object/);
  });
});

describe("removeClaudeHooks", () => {
  it("removes only our entries and prunes empty containers", () => {
    const installed = buildClaudeHooks(
      {
        hooks: {
          PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }],
        },
      },
      WRITER,
      INBOX
    ).config;
    const { config, removed } = removeClaudeHooks(installed);
    expect(removed).toEqual(["claude-code PostToolUse", "claude-code Stop"]);
    const post = (config.hooks as Record<string, unknown>).PostToolUse as unknown[];
    expect(post).toHaveLength(1);
    expect(JSON.stringify(post[0])).toContain("echo mine");
    expect((config.hooks as Record<string, unknown>).Stop).toBeUndefined();
  });

  it("removes ours even alongside foreign entries in the same event", () => {
    const { config } = buildClaudeHooks(
      { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } },
      WRITER,
      INBOX
    );
    const { removed } = removeClaudeHooks(config);
    expect(removed).toEqual(["claude-code PostToolUse", "claude-code Stop"]);
    const pre = (config.hooks as Record<string, unknown>).PreToolUse as unknown[];
    expect(pre).toHaveLength(1);
  });
});

describe("installAgentHooks / uninstallAgentHooks", () => {
  it("installs claude + opencode and reports codex/gemini as manual", async () => {
    const { io, files } = makeIo();
    const results = await installAgentHooks(io, { writerPath: WRITER, inboxPath: INBOX });
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r]));
    expect(byTarget["claude-code"].action).toBe("added");
    expect(byTarget["opencode"].action).toBe("added");
    expect(byTarget["codex"].action).toBe("manual");
    expect(byTarget["gemini"].action).toBe("manual");

    const settings = JSON.parse(files.get(".claude/settings.json")!);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(files.get(".opencode/plugin/curtis-audit.js")).toContain("CurtisAuditHooks");
  });

  it("is idempotent", async () => {
    const { io } = makeIo();
    const opts = { writerPath: WRITER, inboxPath: INBOX };
    await installAgentHooks(io, opts);
    const second = await installAgentHooks(io, opts);
    expect(second.find((r) => r.target === "claude-code")?.action).toBe("already-installed");
    expect(second.find((r) => r.target === "opencode")?.action).toBe("updated");
  });

  it("aborts claude-code on malformed settings.json, untouched", async () => {
    const { io, files } = makeIo({ ".claude/settings.json": "{not json" });
    const results = await installAgentHooks(io, { writerPath: WRITER, inboxPath: INBOX });
    const claude = results.find((r) => r.target === "claude-code") as HookTargetResult;
    expect(claude.action).toBe("aborted");
    expect(files.get(".claude/settings.json")).toBe("{not json");
    // opencode still installs
    expect(results.find((r) => r.target === "opencode")?.action).toBe("added");
  });

  it("round-trips: uninstall restores the pre-install settings", async () => {
    const original = {
      model: "opus",
      hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] },
    };
    const { io, files } = makeIo({ ".claude/settings.json": JSON.stringify(original) });
    const opts = { writerPath: WRITER, inboxPath: INBOX };
    await installAgentHooks(io, opts);
    const uninstall = await uninstallAgentHooks(io);
    expect(uninstall.find((r) => r.target === "claude-code")?.action).toBe("removed");
    expect(JSON.parse(files.get(".claude/settings.json")!)).toEqual(original);
    expect(files.get(".opencode/plugin/curtis-audit.js")).toBe("");
  });

  it("never touches a foreign opencode plugin file", async () => {
    const { io, files } = makeIo({ ".opencode/plugin/curtis-audit.js": "export const Mine = 1" });
    const results = await installAgentHooks(io, { writerPath: WRITER, inboxPath: INBOX });
    expect(results.find((r) => r.target === "opencode")?.action).toBe("aborted");
    expect(files.get(".opencode/plugin/curtis-audit.js")).toBe("export const Mine = 1");
    const uninstall = await uninstallAgentHooks(io);
    expect(uninstall.find((r) => r.target === "opencode")?.action).toBe("aborted");
  });
});

describe("buildOpencodePluginSource", () => {
  it("is a self-contained generated file tagged for uninstall", () => {
    const source = buildOpencodePluginSource(WRITER, INBOX);
    expect(source).toContain("Generated by curtis-ai-audit");
    expect(source).toContain(JSON.stringify(WRITER));
    expect(source).toContain('"tool.execute.after"');
    expect(source).toContain("catch");
  });
});
