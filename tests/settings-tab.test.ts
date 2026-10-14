import { describe, expect, it, vi } from "vitest";
import { AuditSettingTab } from "../src/settings-tab";
import { AuditSettings } from "../src/settings";

function makeTab(settings: AuditSettings) {
  const plugin = {
    settings,
    manifest: { version: "0.0.0-test" },
    saveAndReload: vi.fn(async () => {}),
  };
  const tab = new AuditSettingTab({} as never, plugin as never);
  return { tab, plugin };
}

describe("AuditSettingTab", () => {
  it("exposes declarative definitions for every persisted setting", () => {
    const { tab } = makeTab({} as AuditSettings);
    const defs = tab.getSettingDefinitions();
    const keys = defs
      .map((d) => ("control" in d ? (d.control as { key?: string }).key : undefined))
      .filter(Boolean);
    expect(keys).toEqual([
      "root",
      "messengerRoot",
      "inboxAddress",
      "pollSeconds",
      "retentionDays",
      "debug",
    ]);
  });

  it("declares the same bounds the sanitizer enforces", () => {
    const { tab } = makeTab({} as AuditSettings);
    const defs = tab.getSettingDefinitions();
    const poll = defs.find((d) => "control" in d && (d.control as { key?: string }).key === "pollSeconds");
    const retention = defs.find(
      (d) => "control" in d && (d.control as { key?: string }).key === "retentionDays"
    );
    expect((poll!.control as { min: number; max: number })).toMatchObject({ min: 1, max: 3600 });
    expect((retention!.control as { min: number; max: number })).toMatchObject({ min: 0, max: 36500 });
  });

  it("marks brand/about rows as non-searchable renders", () => {
    const { tab } = makeTab({} as AuditSettings);
    const defs = tab.getSettingDefinitions();
    const renders = defs.filter((d) => "render" in d);
    expect(renders).toHaveLength(2);
    expect(renders.every((d) => (d as { searchable?: boolean }).searchable === false)).toBe(true);
    expect(typeof renders[1].render).toBe("function");
  });

  it("reads the live setting object by key", () => {
    const { tab } = makeTab({ root: "Audit", debug: true } as AuditSettings);
    expect(tab.getControlValue("root")).toBe("Audit");
    expect(tab.getControlValue("debug")).toBe(true);
  });

  it("writes through the plugin and triggers a reload", async () => {
    const settings = { root: "Audit" } as AuditSettings;
    const { tab, plugin } = makeTab(settings);
    await tab.setControlValue("root", "AuditVault");
    expect(settings.root).toBe("AuditVault");
    expect(plugin.saveAndReload).toHaveBeenCalledTimes(1);
  });

  it("ignores keys the settings object does not own", async () => {
    const settings = { root: "Audit" } as AuditSettings;
    const { tab, plugin } = makeTab(settings);
    await tab.setControlValue("notASetting", 1);
    expect(plugin.saveAndReload).not.toHaveBeenCalled();
    expect((settings as unknown as Record<string, unknown>).notASetting).toBeUndefined();
  });
});
