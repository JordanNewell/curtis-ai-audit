import { describe, expect, it } from "vitest";
import { TFolder, Vault, normalizePath } from "obsidian";
import {
  ensureFolder,
  inboxHeader,
  mutateFileAtomic,
  readRegistry,
  upsertRegistryEntry,
  writeFile,
} from "../src/registry";
import { FakeVault } from "./fake-vault";

function asVault(vault: FakeVault): Vault {
  return vault as unknown as Vault;
}

/** Vault whose createFolder/create behave like real clients: throw when present. */
class RacyVault extends FakeVault {
  /** Simulates another writer creating the file between the exists-check and create. */
  async create(path: string, data: string): Promise<void> {
    const p = normalizePath(path);
    if (!this.files.has(p)) {
      await super.create(path, data); // the other writer wins
    }
    throw new Error(`File already exists: ${p}`);
  }
}

class PossessiveVault extends FakeVault {
  async createFolder(path: string): Promise<void> {
    const p = normalizePath(path);
    if (this.folders.has(p)) throw new Error(`Folder already exists: ${p}`);
    await super.createFolder(path);
  }
}

describe("ensureFolder", () => {
  it("creates nested folders", async () => {
    const vault = new FakeVault();
    await ensureFolder(asVault(vault), "Audit/ledger/deep");
    expect(vault.folders.has("Audit")).toBe(true);
    expect(vault.folders.has("Audit/ledger")).toBe(true);
    expect(vault.folders.has("Audit/ledger/deep")).toBe(true);
  });

  it("is a no-op for an empty path", async () => {
    const vault = new FakeVault();
    await ensureFolder(asVault(vault), "");
    expect(vault.folders.size).toBe(0);
  });

  it("skips existing folders and tolerates a creation race", async () => {
    const vault = new PossessiveVault();
    vault.folders.add("Audit");
    await ensureFolder(asVault(vault), "Audit/ledger");
    await ensureFolder(asVault(vault), "Audit/ledger"); // second pass: everything exists
    expect(vault.folders.has("Audit/ledger")).toBe(true);
  });
});

describe("writeFile", () => {
  it("creates the file with parents, then modifies in place", async () => {
    const vault = new FakeVault();
    await writeFile(asVault(vault), "Audit/digest.md", "v1");
    expect(vault.readRaw("Audit/digest.md")).toBe("v1");
    await writeFile(asVault(vault), "Audit/digest.md", "v2");
    expect(vault.readRaw("Audit/digest.md")).toBe("v2");
    expect(vault.files.size).toBe(1);
  });

  it("recovers when creation races another writer", async () => {
    const vault = new RacyVault();
    await writeFile(asVault(vault), "Audit/state.json", "mine");
    // create() threw after the other writer's content landed; we overwrite it
    expect(vault.readRaw("Audit/state.json")).toBe("mine");
  });

  it("throws when a folder occupies the target path instead of dropping the write", async () => {
    // real Obsidian refuses vault.create where a folder lives; the base fake
    // only checks its file map, so model the refusal here
    const vault = new (class extends FakeVault {
      async create(path: string, data: string): Promise<void> {
        if (this.getAbstractFileByPath(path) instanceof TFolder) {
          throw new Error(`Folder in the way: ${path}`);
        }
        await super.create(path, data);
      }
    })({ "Audit/state.json/nested.txt": "x" });
    // the catch re-checks and finds a TFolder (not a TFile) — a real failure
    // must surface, not vanish
    await expect(writeFile(asVault(vault), "Audit/state.json", "lost")).rejects.toThrow(
      /Folder in the way/
    );
  });
});

describe("mutateFileAtomic", () => {
  it("uses Vault#process when available", async () => {
    const vault = new FakeVault({ "Audit/state.json": '{"a":1}' });
    await mutateFileAtomic(asVault(vault), "Audit/state.json", (c) => c + "+");
    expect(vault.readRaw("Audit/state.json")).toBe('{"a":1}+');
    expect(vault.processCalls).toBe(1);
  });

  it("falls back to read+modify when the API lacks process", async () => {
    const vault = new FakeVault({ "Audit/state.json": "x" });
    const bare = {
      getAbstractFileByPath: (p: string) => vault.getAbstractFileByPath(p),
      read: (f: never) => vault.read(f),
      modify: (f: never, data: string) => vault.modify(f, data),
    };
    await mutateFileAtomic(bare as unknown as Vault, "Audit/state.json", (c) => c + "!");
    expect(vault.readRaw("Audit/state.json")).toBe("x!");
  });

  it("throws when the file does not exist", async () => {
    const vault = new FakeVault();
    await expect(
      mutateFileAtomic(asVault(vault), "Audit/state.json", (c) => c)
    ).rejects.toThrow(/no file/);
  });
});

describe("inboxHeader", () => {
  it("addresses the inbox and warns against reordering", () => {
    const header = inboxHeader("audit");
    expect(header).toContain("audit");
    expect(header).toContain("Append-only");
  });
});

describe("upsertRegistryEntry / readRegistry", () => {
  it("creates a registry table and keeps entries address-sorted", async () => {
    const vault = new FakeVault();
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "z-agent",
      name: "Zed",
      updated: "2026-10-10T00:00:00.000Z",
    });
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "a-agent",
      name: "Ay",
      updated: "2026-10-11T00:00:00.000Z",
    });
    const content = vault.readRaw("Messenger/registry.md") ?? "";
    expect(content).toContain("# Messenger registry");
    expect(content).toContain("| a-agent | Ay | 2026-10-11T00:00:00.000Z |");
    expect(content.indexOf("| a-agent")).toBeLessThan(content.indexOf("| z-agent"));
  });

  it("replaces an existing address without compounding phantom header rows", async () => {
    const vault = new FakeVault();
    const entry = { address: "audit", name: "old name", updated: "t1" };
    await upsertRegistryEntry(asVault(vault), "Messenger", entry);
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "audit",
      name: "new name",
      updated: "t2",
    });
    const entries = await readRegistry(asVault(vault), "Messenger");
    // the header row parses as a valid entry ("address" passes ADDRESS_RE) in
    // older builds and compounded on every upsert; it is now skipped on read
    // and dropped on rewrite
    expect(entries.filter((e) => e.address === "address")).toHaveLength(0);
    // the real entry itself is replaced, not duplicated
    const audit = entries.filter((e) => e.address === "audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ address: "audit", name: "new name", updated: "t2" });
  });

  it("round-trips escaped pipes through upsert and read", async () => {
    const vault = new FakeVault();
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "audit",
      name: "audit | inbox",
      updated: "a|b",
    });
    // the row is written with `\|` and read back by splitting on unescaped
    // pipes only, so both cells survive intact
    expect(vault.readRaw("Messenger/registry.md")).toContain("| audit | audit \\| inbox | a\\|b |");
    const entries = await readRegistry(asVault(vault), "Messenger");
    const audit = entries.find((e) => e.address === "audit");
    expect(audit?.name).toBe("audit | inbox");
    expect(audit?.updated).toBe("a|b");
  });

  it("does not double-escape an already-escaped pipe on rewrite", async () => {
    const vault = new FakeVault();
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "audit",
      name: "audit | inbox",
      updated: "t1",
    });
    // second upsert re-reads the escaped value and rewrites it — `\|` must
    // stay `\|`, never become `\\|`
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "audit",
      name: "audit | inbox",
      updated: "t2",
    });
    const content = vault.readRaw("Messenger/registry.md") ?? "";
    expect(content).toContain("audit \\| inbox");
    expect(content).not.toContain("\\\\|");
    const entries = await readRegistry(asVault(vault), "Messenger");
    expect(entries.find((e) => e.address === "audit")?.name).toBe("audit | inbox");
  });

  it("rejects an invalid address", async () => {
    const vault = new FakeVault();
    await expect(
      upsertRegistryEntry(asVault(vault), "Messenger", {
        address: "not an address",
        name: "x",
        updated: "t",
      })
    ).rejects.toThrow(/Invalid messenger address/);
  });

  it("returns an empty list when the registry does not exist", async () => {
    const entries = await readRegistry(asVault(new FakeVault()), "Messenger");
    expect(entries).toEqual([]);
  });

  it("skips the header row, separators, and invalid addresses", async () => {
    const vault = new FakeVault({
      "Messenger/registry.md":
        "# Messenger registry\n\n" +
        "| address | name | updated |\n" +
        "| --- | --- | --- |\n" +
        "| audit | Audit | t1 |\n" +
        "| BAD ADDRESS! | broken | t2 |\n" +
        "not a table row\n",
    });
    const entries = await readRegistry(asVault(vault), "Messenger");
    // the header row ("address" satisfies ADDRESS_RE) is recognized and
    // skipped; only the real entry survives
    expect(entries.map((e) => e.address)).toEqual(["audit"]);
    expect(entries[0]).toMatchObject({ address: "audit", name: "Audit", updated: "t1" });
  });

  it("self-heals: upsert drops pre-existing phantom header rows and invalid addresses", async () => {
    const vault = new FakeVault({
      "Messenger/registry.md":
        "# Messenger registry\n\n" +
        "| address | name | updated |\n" +
        "| --- | --- | --- |\n" +
        // a phantom row an older build persisted as data (identical to the header)
        "| address | name | updated |\n" +
        "| BAD! | broken | t2 |\n" +
        "| audit | Audit | t1 |\n",
    });
    await upsertRegistryEntry(asVault(vault), "Messenger", {
      address: "b-agent",
      name: "Bee",
      updated: "t3",
    });
    const content = vault.readRaw("Messenger/registry.md") ?? "";
    // only the genuine header line mentions the literal "address" cell
    expect(content.match(/\| address \|/g)).toHaveLength(1);
    const entries = await readRegistry(asVault(vault), "Messenger");
    expect(entries.map((e) => e.address)).toEqual(["audit", "b-agent"]);
  });

  it("falls back to the address as the name when the name cell is empty", async () => {
    const vault = new FakeVault({
      "Messenger/registry.md": "| audit | | t1 |\n",
    });
    const entries = await readRegistry(asVault(vault), "Messenger");
    expect(entries[0].name).toBe("audit");
  });
});
