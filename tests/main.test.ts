import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Vault } from "obsidian";
import CurtisAuditPlugin from "../src/main";
import { AuditSettings } from "../src/settings";
import { HookTargetResult } from "../src/hooks-install";
import { AuditReceiptV1, buildReceipt } from "../src/schema";
import { encodeBlock } from "../src/protocol";
import { FakeVault, fakeFileManager } from "./fake-vault";

// main.ts touches `window` for the public API and the pump interval
(globalThis as { window?: unknown }).window = globalThis;

const LEDGER_MARKER = "curtis-audit";

class FakeDesktopAdapter extends FileSystemAdapter {
  constructor(private base: string) {
    super();
  }
  getBasePath(): string {
    return this.base;
  }
}

function makePlugin(vault: FakeVault, stored: Partial<AuditSettings> = {}) {
  const commands: { id: string; name: string; callback?: () => void }[] = [];
  const saved: unknown[] = [];
  const app = {
    vault: vault as unknown as Vault,
    fileManager: fakeFileManager(vault),
    workspace: { trigger: vi.fn(), getLeaf: vi.fn() },
  };
  const plugin = new CurtisAuditPlugin(app as never);
  Object.assign(plugin, {
    loadData: async () => stored,
    saveData: async (value: unknown) => void saved.push(value),
    addRibbonIcon: () => ({}),
    addCommand: (cmd: { id: string }) => void commands.push(cmd),
    registerInterval: (id: number) => id,
    addSettingTab: () => {},
  });
  return { plugin, commands, saved, app };
}

function seedReceipt(day: string, seq: number, hour: number): string {
  const receipt = buildReceipt(
    { agent: "curtis-ai-chat", action: "inference", summary: "seeded" },
    { agent: "curtis-ai-chat" }
  );
  Object.assign(receipt, {
    seq,
    recorded: `${day}T0${hour}:00:00.000Z`,
    id: `rcp_${day}_${seq}`,
  });
  return encodeBlock(LEDGER_MARKER, receipt as unknown as Record<string, unknown>, "body");
}

describe("plugin lifecycle", () => {
  beforeEach(() => {
    delete (globalThis as { curtisAudit?: unknown }).curtisAudit;
  });

  it("onload registers the commands, the API, and the ledger folder", async () => {
    const vault = new FakeVault();
    const { plugin, commands } = makePlugin(vault);
    await plugin.onload();

    expect(commands.map((c) => c.id)).toEqual([
      "check",
      "verify",
      "digest",
      "prune",
      "open-today",
      "install-hooks",
      "uninstall-hooks",
    ]);
    expect(vault.folders.has("Audit/ledger")).toBe(true);
    expect((globalThis as { curtisAudit?: unknown }).curtisAudit).toBe(plugin.api);

    plugin.onunload();
    expect((globalThis as { curtisAudit?: unknown }).curtisAudit).toBeUndefined();
  });

  it("loadSettings sanitizes persisted data", async () => {
    const { plugin } = makePlugin(new FakeVault(), {
      pollSeconds: 99999,
      root: "C:\\Audit",
      retentionDays: -3,
    });
    await plugin.onload();
    expect(plugin.settings.pollSeconds).toBe(3600);
    expect(plugin.settings.root).toBe("C:/Audit");
    expect(plugin.settings.retentionDays).toBe(0);
    plugin.onunload();
  });
});

describe("joinBusIfPresent", () => {
  it("does not create a bus when no messenger root exists", async () => {
    const vault = new FakeVault();
    const { plugin } = makePlugin(vault);
    await plugin.onload();
    expect(vault.files.has("Messenger/audit/inbox.md")).toBe(false);
    plugin.onunload();
  });

  it("joins an existing bus: inbox, header, and registry entries", async () => {
    const vault = new FakeVault({ "Messenger/other/inbox.md": "# Inbox — other\n" });
    const { plugin } = makePlugin(vault);
    await plugin.onload();

    const inbox = vault.readRaw("Messenger/audit/inbox.md") ?? "";
    expect(inbox).toContain("# Inbox — audit");
    expect(inbox).toContain("Append-only");

    const registry = vault.readRaw("Messenger/registry.md") ?? "";
    expect(registry).toContain("| audit |");
    expect(registry).toContain("| curtis-ai-audit |");
    plugin.onunload();
  });
});

describe("cursors survive a settings reload", () => {
  it("saveAndReload rebuilds components and restores ingest cursors", async () => {
    const vault = new FakeVault();
    const { plugin, saved } = makePlugin(vault);
    await plugin.onload();

    plugin.ingestor.setCursors({
      "Messenger/audit/inbox.md": { id: "msg_9", ts: "2026-10-10T00:00:00.000Z" },
    });
    plugin.settings.root = "AuditTwo";
    await plugin.saveAndReload();

    expect(plugin.ledger.ledgerDir).toBe("AuditTwo/ledger");
    expect(plugin.ingestor.getCursors()).toEqual({
      "Messenger/audit/inbox.md": { id: "msg_9", ts: "2026-10-10T00:00:00.000Z" },
    });
    expect(saved.length).toBeGreaterThan(0);
    expect(vault.folders.has("AuditTwo/ledger")).toBe(true);
    plugin.onunload();
  });

  it("saveAndReload sanitizes settings before persisting", async () => {
    const { plugin, saved } = makePlugin(new FakeVault());
    await plugin.onload();
    // drift that could arrive through a hand-edited data.json
    Object.assign(plugin.settings, { pollSeconds: 0.5, retentionDays: -3 });
    await plugin.saveAndReload();
    const persisted = saved[saved.length - 1] as AuditSettings;
    expect(persisted.pollSeconds).toBeGreaterThanOrEqual(1);
    expect(persisted.retentionDays).toBe(0);
    plugin.onunload();
  });
});

describe("checkNow / pump", () => {
  it("checkNow polls the inbox and persists cursors", async () => {
    const vault = new FakeVault({ "Messenger/x/inbox.md": "seed\n" });
    vault.files.set(
      "Messenger/audit/inbox.md",
      "# Inbox — audit\n\n" +
        encodeBlock(
          "messenger",
          {
            id: "msg_1",
            from: "curtis-ai-chat",
            to: "audit",
            ts: "2026-10-10T00:00:00.000Z",
            replyTo: null,
          },
          '{"action":"inference"}'
        )
    );
    const { plugin, saved } = makePlugin(vault);
    await plugin.onload();

    await (plugin as unknown as { checkNow(): Promise<void> }).checkNow();
    const persisted = saved[saved.length - 1] as AuditSettings;
    expect(persisted.cursors["Messenger/audit/inbox.md"].id).toBe("msg_1");
    expect(await plugin.ledger.readAll()).toHaveLength(1);
    plugin.onunload();
  });

  it("checkNow is a no-op when the bus is disabled", async () => {
    const { plugin, saved } = makePlugin(new FakeVault());
    await plugin.onload();
    plugin.settings.messengerRoot = "";
    await (plugin as unknown as { checkNow(): Promise<void> }).checkNow();
    expect(saved).toHaveLength(0);
    plugin.onunload();
  });

  it("pumpGate throttles polling by pollSeconds", async () => {
    const { plugin } = makePlugin(new FakeVault());
    await plugin.onload();
    plugin.settings.pollSeconds = 3600;
    const spy = vi.spyOn(plugin.ingestor, "poll").mockResolvedValue({
      delivered: 0,
      receipts: 0,
      rejected: 0,
      duplicates: 0,
    });
    const gate = (plugin as unknown as { pumpGate(): void }).pumpGate.bind(plugin);
    gate();
    gate();
    gate();
    expect(spy).toHaveBeenCalledTimes(1);
    plugin.onunload();
  });

  it("pump swallows ingest errors instead of throwing", async () => {
    const { plugin } = makePlugin(new FakeVault());
    await plugin.onload();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(plugin.ingestor, "poll").mockRejectedValue(new Error("disk on fire"));
    await (plugin as unknown as { pump(): Promise<void> }).pump();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    plugin.onunload();
  });

  it("pump persists cursors whenever they changed, even when its own poll delivered 0", async () => {
    // an external api.poll() consumed the inbox and moved the in-memory
    // cursor; the pump's later poll delivers 0 but the cursor still changed
    const vault = new FakeVault();
    vault.files.set(
      "Messenger/audit/inbox.md",
      "# Inbox — audit\n\n" +
        encodeBlock(
          "messenger",
          { id: "msg_1", from: "curtis-ai-chat", to: "audit", ts: "2026-10-10T00:00:00.000Z", replyTo: null },
          '{"action":"inference"}'
        )
    );
    const { plugin, saved } = makePlugin(vault);
    await plugin.onload();

    await plugin.api.poll(); // external consumer; its hook persists
    await (plugin as unknown as { pump(): Promise<void> }).pump(); // delivers 0
    const persisted = saved[saved.length - 1] as AuditSettings;
    expect(persisted.cursors["Messenger/audit/inbox.md"].id).toBe("msg_1");
    plugin.onunload();
  });

  it("pump skips the settings write when the cursor did not move", async () => {
    const { plugin, saved } = makePlugin(new FakeVault());
    await plugin.onload();
    plugin.settings.messengerRoot = "Messenger";
    await (plugin as unknown as { pump(): Promise<void> }).pump();
    expect(saved).toHaveLength(0);
    plugin.onunload();
  });
});

describe("retention pump", () => {
  it("runPrune drops old receipts and journals the pass as a prune receipt", async () => {
    const vault = new FakeVault();
    const oldDay = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    vault.files.set(
      `Audit/ledger/${oldDay}.md`,
      `# Audit ledger — ${oldDay}\n\n` + seedReceipt(oldDay, 0, 1) + seedReceipt(oldDay, 1, 2)
    );
    const { plugin } = makePlugin(vault);
    await plugin.onload();
    plugin.settings.retentionDays = 7;

    const runPrune = (plugin as unknown as { runPrune(): Promise<number> }).runPrune.bind(plugin);
    expect(await runPrune()).toBe(2);

    const remaining = await plugin.ledger.readAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agent).toBe("curtis-ai-audit");
    expect(remaining[0].action).toBe("prune");
    expect(remaining[0].detail).toEqual({ dropped: 2, retentionDays: 7 });
    plugin.onunload();
  });

  it("records the prune receipt before the destructive pass (SPEC §7)", async () => {
    // if the receipt write failed after the shards were already pruned, the
    // seq gaps would be unexplained in-ledger
    const vault = new FakeVault();
    const oldDay = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    vault.files.set(
      `Audit/ledger/${oldDay}.md`,
      `# Audit ledger — ${oldDay}\n\n` + seedReceipt(oldDay, 0, 1) + seedReceipt(oldDay, 1, 2)
    );
    const { plugin } = makePlugin(vault);
    await plugin.onload();
    plugin.settings.retentionDays = 7;

    vi.spyOn(plugin.api, "record").mockRejectedValue(new Error("receipt write failed"));
    const runPrune = (plugin as unknown as { runPrune(): Promise<number> }).runPrune.bind(plugin);
    await expect(runPrune()).rejects.toThrow("receipt write failed");

    // the destructive step never ran: the old receipts are still there
    const remaining = await plugin.ledger.readAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.every((r) => r.agent === "curtis-ai-chat")).toBe(true);
    plugin.onunload();
  });

  it("runPrune is a no-op with retention off", async () => {
    const vault = new FakeVault();
    const oldDay = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    vault.files.set(
      `Audit/ledger/${oldDay}.md`,
      `# Audit ledger — ${oldDay}\n\n` + seedReceipt(oldDay, 0, 1)
    );
    const { plugin } = makePlugin(vault);
    await plugin.onload();
    plugin.settings.retentionDays = 0;
    const runPrune = (plugin as unknown as { runPrune(): Promise<number> }).runPrune.bind(plugin);
    expect(await runPrune()).toBe(0);
    expect(await plugin.ledger.readAll()).toHaveLength(1);
    plugin.onunload();
  });

  it("pump prunes at most once an hour when retention is on", async () => {
    const vault = new FakeVault();
    const { plugin } = makePlugin(vault);
    await plugin.onload();
    plugin.settings.retentionDays = 7;
    const pruneSpy = vi.spyOn(plugin.ledger, "prune").mockResolvedValue(0);
    const pump = (plugin as unknown as { pump(): Promise<void> }).pump.bind(plugin);
    await pump();
    await pump();
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    plugin.onunload();
  });
});

describe("hook paths and notices", () => {
  it("hookPaths resolves vault-desktop paths", () => {
    const vault = new FakeVault();
    const { plugin } = makePlugin(vault);
    (plugin as unknown as { manifest: { dir: string } }).manifest = {
      dir: ".obsidian/plugins/curtis-ai-audit",
    };
    (vault as unknown as { adapter: unknown }).adapter = new FakeDesktopAdapter("E:/vault");

    const paths = (
      plugin as unknown as { hookPaths(): { writerPath: string; inboxPath: string } | null }
    ).hookPaths();
    expect(paths).toEqual({
      writerPath: "E:/vault/.obsidian/plugins/curtis-ai-audit/bin/curtis-audit-file.mjs",
      inboxPath: "E:/vault/Messenger/audit/inbox.md",
    });
  });

  it("hookPaths returns null without a desktop adapter (mobile)", () => {
    const vault = new FakeVault();
    const { plugin } = makePlugin(vault);
    (vault as unknown as { adapter: unknown }).adapter = {};
    expect(
      (plugin as unknown as { hookPaths(): unknown }).hookPaths()
    ).toBeNull();
  });

  it("hookIo reads through the adapter, null for missing files", async () => {
    const vault = new FakeVault({ "exists.txt": "hello" });
    const { plugin } = makePlugin(vault);
    (vault as unknown as { adapter: unknown }).adapter = {
      read: async (p: string) => {
        const content = vault.readRaw(p);
        if (content === undefined) throw new Error("not found");
        return content;
      },
      write: async (p: string, content: string) => void vault.files.set(p, content),
      mkdir: async () => {},
    };
    const io = (plugin as unknown as { hookIo(): unknown }).hookIo() as {
      readText(p: string): Promise<string | null>;
      writeText(p: string, c: string): Promise<void>;
    };
    expect(await io.readText("exists.txt")).toBe("hello");
    expect(await io.readText("nope.txt")).toBeNull();
    await io.writeText("deep/nested/out.txt", "written");
    expect(vault.readRaw("deep/nested/out.txt")).toBe("written");
  });

  it("hookIo deletes through the adapter, tolerating missing files", async () => {
    const vault = new FakeVault({ "gone-soon.txt": "bye" });
    const { plugin } = makePlugin(vault);
    (vault as unknown as { adapter: unknown }).adapter = {
      remove: async (p: string) => {
        if (!vault.files.delete(p)) throw new Error("not found");
      },
    };
    const io = (plugin as unknown as { hookIo(): unknown }).hookIo() as {
      deleteText?(p: string): Promise<void>;
    };
    expect(typeof io.deleteText).toBe("function");
    await io.deleteText!("gone-soon.txt");
    expect(vault.readRaw("gone-soon.txt")).toBeUndefined();
    // deleting a missing file is fine (uninstall idempotence)
    await io.deleteText!("never-was-there.txt");
  });

  it("hookNotice summarizes install results", () => {
    const { plugin } = makePlugin(new FakeVault());
    const results: HookTargetResult[] = [
      { target: "claude-code", action: "added" },
      { target: "opencode", action: "updated" },
      { target: "codex", action: "manual", detail: "recipe" },
      { target: "gemini", action: "aborted" },
    ];
    const notice = (
      plugin as unknown as { hookNotice(verb: string, results: HookTargetResult[]): string }
    ).hookNotice("install", results);
    expect(notice).toBe(
      "Audit hooks — installed: claude-code, opencode · manual: codex · skipped: gemini · " +
        "approve Claude Code project hooks once via /hooks"
    );
  });

  it("hookNotice reports already-installed and uninstall wording", () => {
    const { plugin } = makePlugin(new FakeVault());
    const hookNotice = (
      plugin as unknown as { hookNotice(verb: string, results: HookTargetResult[]): string }
    ).hookNotice.bind(plugin);
    expect(hookNotice("install", [{ target: "claude-code", action: "already-installed" }])).toBe(
      "Audit hooks — nothing to change · approve Claude Code project hooks once via /hooks"
    );
    expect(
      hookNotice("uninstall", [
        { target: "claude-code", action: "removed" },
        { target: "opencode", action: "aborted", detail: "not ours" },
      ])
    ).toBe("Audit hooks — uninstalled: claude-code · skipped: opencode");
    // uninstall reports hooks that were never installed the same way
    expect(hookNotice("uninstall", [{ target: "codex", action: "not-installed" }])).toBe(
      "Audit hooks — nothing to change"
    );
  });
});
