import { expect, test } from "bun:test";
import { join } from "node:path";

const script = join(import.meta.dir, "release-download-names.sh");

function downloadName(installer: string) {
  const result = Bun.spawnSync(["bash", script, installer], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    name: result.stdout.toString().trim(),
    err: result.stderr.toString(),
  };
}

const list = (flag: string) =>
  Bun.spawnSync(["bash", script, flag]).stdout.toString().trim().split("\n");

test("each installer Tauri names gets its fixed download name", () => {
  expect(downloadName("OpenBot_0.3.0_aarch64.dmg").name).toBe(
    "OpenBot-mac-arm64.dmg",
  );
  expect(downloadName("OpenBot_0.3.0_x64-setup.exe").name).toBe(
    "OpenBot-windows-x64-setup.exe",
  );
});

test("a candidate or beta maps to the same fixed names", () => {
  expect(downloadName("OpenBot_0.3.0-rc.2_aarch64.dmg").name).toBe(
    "OpenBot-mac-arm64.dmg",
  );
  expect(downloadName("OpenBot_0.3.0-beta.1_x64-setup.exe").name).toBe(
    "OpenBot-windows-x64-setup.exe",
  );
});

test("a path is read by its file name", () => {
  expect(
    downloadName(
      "installers/openbot-desktop-macos/dmg/OpenBot_1.0.0_aarch64.dmg",
    ).name,
  ).toBe("OpenBot-mac-arm64.dmg");
});

test("any other file has no fixed name, and fails", () => {
  for (const name of [
    "OpenBot-mac-arm64.dmg",
    "OpenBot_0.3.0_x64.msi",
    "OpenBot_0.3.0_amd64.AppImage",
    "OpenBot_0.3.0_aarch64.dmg.sig",
    "Other_0.3.0_aarch64.dmg",
    "openbot-desktop.exe",
  ]) {
    const result = downloadName(name);
    expect(result.code).toBe(1);
    expect(result.name).toBe("");
    expect(result.err).toContain(
      "is not an installer with a fixed download name",
    );
  }
});

// The Mac app ships for Apple silicon only. An Intel .dmg that turned up anyway would otherwise be
// attached under a name no release publishes any more, and keep the Intel download alive.
test("an Intel Mac .dmg has no fixed name, and fails", () => {
  for (const name of ["OpenBot_1.0.0_x64.dmg", "OpenBot_1.0.0-rc.1_x64.dmg"]) {
    const result = downloadName(name);
    expect(result.code).toBe(1);
    expect(result.name).toBe("");
    expect(result.err).toContain(
      "is not an installer with a fixed download name",
    );
  }
});

// A stable release waits for every one of these to be signed before it becomes Latest, so the list
// must be exactly the names the installers map to: the Apple silicon Mac one and the Windows one.
test("--all lists every fixed name an installer maps to", () => {
  expect(list("--all")).toEqual(
    ["OpenBot_1.0.0_aarch64.dmg", "OpenBot_1.0.0_x64-setup.exe"].map(
      (installer) => downloadName(installer).name,
    ),
  );
  expect(list("--all")).toEqual([
    "OpenBot-mac-arm64.dmg",
    "OpenBot-windows-x64-setup.exe",
  ]);
});

// Downloads sync removes latest/<name> for each of these once the Latest release lacks it, so a
// name that is still published must never be listed here.
test("--retired lists the Intel Mac name, and nothing still published", () => {
  expect(list("--retired")).toEqual(["OpenBot-mac-x64.dmg"]);
  for (const name of list("--retired")) {
    expect(list("--all")).not.toContain(name);
  }
});
