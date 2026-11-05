import { expect, test } from "bun:test";
import { downloadName } from "./release-download-names";

test("each installer Tauri names gets its fixed download name", () => {
  expect(downloadName("OpenBot_0.3.0_aarch64.dmg")).toBe(
    "OpenBot-mac-arm64.dmg",
  );
  expect(downloadName("OpenBot_0.3.0_x64.dmg")).toBe("OpenBot-mac-x64.dmg");
  expect(downloadName("OpenBot_0.3.0_x64-setup.exe")).toBe(
    "OpenBot-windows-x64-setup.exe",
  );
});

test("a candidate or beta maps to the same fixed names", () => {
  expect(downloadName("OpenBot_0.3.0-rc.2_aarch64.dmg")).toBe(
    "OpenBot-mac-arm64.dmg",
  );
  expect(downloadName("OpenBot_0.3.0-beta.1_x64-setup.exe")).toBe(
    "OpenBot-windows-x64-setup.exe",
  );
});

test("a path is read by its file name", () => {
  expect(
    downloadName("installers/openbot-desktop-macos/dmg/OpenBot_0.3.0_x64.dmg"),
  ).toBe("OpenBot-mac-x64.dmg");
});

test("any other file has no fixed name", () => {
  for (const name of [
    "OpenBot-mac-arm64.dmg",
    "OpenBot_0.3.0_x64.msi",
    "OpenBot_0.3.0_amd64.AppImage",
    "OpenBot_0.3.0_aarch64.dmg.sig",
    "Other_0.3.0_aarch64.dmg",
    "openbot-desktop.exe",
  ]) {
    expect(downloadName(name)).toBeUndefined();
  }
});
