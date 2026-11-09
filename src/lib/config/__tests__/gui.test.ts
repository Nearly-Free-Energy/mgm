import { afterEach, describe, expect, it, vi } from "vitest";
import { GUI_CONTRACT, type GuiMeta } from "@/lib/gui/contract";
import { DEFAULT_GUI, GuiSettingError, readGuiName, validateGuiAtStartup } from "../gui";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/gui/meta");
  vi.resetModules();
});

describe("readGuiName", () => {
  it("selects Gridtop when MGM_GUI is unset or blank", () => {
    expect(DEFAULT_GUI).toBe("gridtop");
    expect(readGuiName({})).toBe("gridtop");
    expect(readGuiName({ MGM_GUI: "" })).toBe("gridtop");
    expect(readGuiName({ MGM_GUI: "  " })).toBe("gridtop");
  });

  it("reads process.env when called without an argument", () => {
    vi.stubEnv("MGM_GUI", "nextgrid");
    expect(() => readGuiName()).toThrow(GuiSettingError);
    vi.stubEnv("MGM_GUI", "");
    expect(readGuiName()).toBe("gridtop");
  });

  it("selects an installed GUI by name", () => {
    expect(readGuiName({ MGM_GUI: "gridtop" })).toBe("gridtop");
    expect(readGuiName({ MGM_GUI: " gridtop\n" })).toBe("gridtop");
  });

  it("refuses a name no GUI has, naming the variable and the installed GUIs", () => {
    const read = () => readGuiName({ MGM_GUI: "nextgrid" });
    expect(read).toThrow(GuiSettingError);
    expect(read).toThrow('MGM_GUI "nextgrid" names no installed GUI. Installed: gridtop.');
  });

  it("never prints a value that is not shaped like a GUI name", () => {
    for (const value of ["sk_live_abc123", "Gridtop", "https://example.test", "a", "-a", "a".repeat(32), "a".repeat(40)]) {
      let message = "";
      try {
        readGuiName({ MGM_GUI: value });
      } catch (error) {
        expect(error).toBeInstanceOf(GuiSettingError);
        message = (error as Error).message;
      }
      expect(message).toBe("MGM_GUI names no installed GUI. Installed: gridtop.");
    }
  });

  it("quotes a value at the longest GUI-name length", () => {
    const longest = "a".repeat(31);
    expect(() => readGuiName({ MGM_GUI: longest })).toThrow(
      `MGM_GUI "${longest}" names no installed GUI. Installed: gridtop.`,
    );
  });

  it("does not take an inherited property for a GUI", () => {
    expect(() => readGuiName({ MGM_GUI: "constructor" })).toThrow(GuiSettingError);
    expect(() => readGuiName({ MGM_GUI: "__proto__" })).toThrow(GuiSettingError);
  });

  it("refuses a GUI whose range excludes this build's contract, naming both versions", async () => {
    const stale: GuiMeta = {
      name: "stale",
      title: "Stale",
      version: "0.2.0",
      contract: "^0.2",
      styles: "./styles.css",
      dependencies: [],
    };
    vi.resetModules();
    vi.doMock("@/gui/meta", () => ({ GUI_META: { stale } }));
    const fresh = await import("../gui");
    expect(() => fresh.readGuiName({ MGM_GUI: "stale" })).toThrow(
      `MGM_GUI selects stale 0.2.0, which supports GUI contract ^0.2; this build provides ${GUI_CONTRACT}.`,
    );
  });
});

describe("validateGuiAtStartup", () => {
  it("accepts an unset or installed name and throws the reading error otherwise", () => {
    expect(() => validateGuiAtStartup({})).not.toThrow();
    expect(() => validateGuiAtStartup({ MGM_GUI: "gridtop" })).not.toThrow();
    expect(() => validateGuiAtStartup({ MGM_GUI: "nextgrid" })).toThrow(GuiSettingError);
  });
});
