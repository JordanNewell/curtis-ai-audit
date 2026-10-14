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
    deleteText: async (p) => void files.delete(p),
  };
  return { io, files };
}

const WRITER = "C:/vault/.obsidian/plugins/curtis-ai-audit/bin/curtis-audit-file.mjs";
const INBOX = "C:/vault/Messenger/audit/inbox.md";

describe("writerCommand", () => {
  it("single-quotes path-like tokens for POSIX sh, leaves flags bare", () => {
    expect(writerCommand(WRITER, INBOX, "claude-code", ["--action", "agent-turn"])).toBe(
      `node '${WRITER}' --agent claude-code --inbox '${INBOX}' --action agent-turn`
    );
  });

  it("keeps shell metacharacters literal inside quoted args", () => {
    // double quotes would expand $ and backticks under sh; single quotes do not
    const command = writerCommand(
      "/vault/my $agent/`x`/curtis-audit-file.mjs",
      INBOX,
      "claude-code"
    );
    expect(command).toBe(
      "node '/vault/my $agent/`x`/curtis-audit-file.mjs' --agent claude-code " +
        `--inbox '${INBOX}'`
    );
  });

  it("re-enters quoting for an embedded single quote", () => {
    const command = writerCommand("/vault/it's/curtis-audit-file.mjs", INBOX, "claude-code");
    expect(command).toBe(
      `node '/vault/it'\\''s/curtis-audit-file.mjs' --agent claude-code --inbox '${INBOX}'`
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

  it("round-trips: uninstall restores the pre-install settings and deletes the generated plugin", async () => {
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
    // deleted through io.deleteText — writing "" would leave a zero-byte ESM
    // file whose missing marker bricks the next install
    expect(uninstall.find((r) => r.target === "opencode")?.action).toBe("removed");
    expect(files.has(".opencode/plugin/curtis-audit.js")).toBe(false);
  });

  it("uninstall → reinstall works (no zero-byte stub bricking the marker check)", async () => {
    const { io, files } = makeIo();
    const opts = { writerPath: WRITER, inboxPath: INBOX };
    await installAgentHooks(io, opts);
    const uninstall = await uninstallAgentHooks(io);
    expect(uninstall.find((r) => r.target === "opencode")?.action).toBe("removed");
    expect(files.get(".opencode/plugin/curtis-audit.js")).toBeUndefined();
    const reinstall = await installAgentHooks(io, opts);
    expect(reinstall.find((r) => r.target === "opencode")?.action).toBe("added");
    expect(files.get(".opencode/plugin/curtis-audit.js")).toContain("Generated by curtis-ai-audit");
  });

  it("reports manual for the generated plugin when the io cannot delete", async () => {
    const { io, files } = makeIo();
    const noDelete: HookIo = { readText: io.readText, writeText: io.writeText };
    await installAgentHooks(io, { writerPath: WRITER, inboxPath: INBOX });
    const results = await uninstallAgentHooks(noDelete);
    const opencode = results.find((r) => r.target === "opencode") as HookTargetResult;
    expect(opencode.action).toBe("manual");
    expect(opencode.detail).toContain("curtis-audit.js");
    // untouched rather than truncated to a zero-byte file
    expect(files.get(".opencode/plugin/curtis-audit.js")).toContain("CurtisAuditHooks");
  });

  it("reports not-installed when nothing was ever installed", async () => {
    const { io } = makeIo();
    const results = await uninstallAgentHooks(io);
    expect(results.find((r) => r.target === "claude-code")?.action).toBe("not-installed");
    expect(results.find((r) => r.target === "opencode")?.action).toBe("not-installed");
  });

  it("reports not-installed when the settings exist but carry none of our entries", async () => {
    const { io } = makeIo({ ".claude/settings.json": JSON.stringify({ model: "opus" }) });
    const results = await uninstallAgentHooks(io);
    expect(results.find((r) => r.target === "claude-code")?.action).toBe("not-installed");
  });

  it("never touches a foreign opencode plugin file", async () => {
    const { io, files } = makeIo({ ".opencode/plugin/curtis-audit.js": "export const Mine = 1" });
    const results = await installAgentHooks(io, { writerPath: WRITER, inboxPath: INBOX });
    expect(results.find((r) => r.target === "opencode")?.action).toBe("aborted");
    expect(files.get(".opencode/plugin/curtis-audit.js")).toBe("export const Mine = 1");
    const uninstall = await uninstallAgentHooks(io);
    expect(uninstall.find((r) => r.target === "opencode")?.action).toBe("aborted");
  });

  it("keeps a foreign hook entry that merely mentions the writer script", async () => {
    // a user wrapper referencing our writer must survive uninstall — only
    // entries whose command invokes the writer as its program are ours
    const wrapper = {
      hooks: {
        PostToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `bash ~/.wrappers/log-to-audit.sh # forwards via curtis-audit-file.mjs`,
              },
            ],
          },
        ],
      },
    };
    const { io, files } = makeIo({ ".claude/settings.json": JSON.stringify(wrapper) });
    const results = await uninstallAgentHooks(io);
    expect(results.find((r) => r.target === "claude-code")?.action).toBe("not-installed");
    expect(JSON.parse(files.get(".claude/settings.json")!)).toEqual(wrapper);
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
