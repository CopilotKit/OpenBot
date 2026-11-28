import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noConfigRestart } from "./noConfigRestart";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A fake Vite dev server with a real config file, and what the plugin did to it. */
function fakeServer() {
  const dir = mkdtempSync(join(tmpdir(), "no-config-restart-"));
  dirs.push(dir);
  const configFile = join(dir, "vite.workbench.config.ts");
  const dep = join(dir, "server.ts");
  writeFileSync(configFile, "export default {};\n");
  writeFileSync(dep, "export {};\n");
  const warnings: string[] = [];
  const unwatched: string[] = [];
  const changeListeners: ((file: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const server = {
    config: {
      configFile,
      configFileDependencies: [configFile, dep],
      logger: { warn: (message: string) => warnings.push(message) },
    },
    watcher: {
      unwatch: (path: string) => unwatched.push(path),
      on: (_event: "change", listener: (file: string) => void) =>
        changeListeners.push(listener),
    },
    httpServer: {
      once: (_event: "close", listener: () => void) =>
        closeListeners.push(listener),
    },
  };
  noConfigRestart().configureServer(server);
  return {
    server,
    configFile,
    dep,
    warnings,
    unwatched,
    change: (file: string) => {
      for (const listener of changeListeners) listener(file);
    },
    close: () => {
      for (const listener of closeListeners) listener();
    },
  };
}

const settle = () => new Promise((done) => setTimeout(done, 300));

test("Vite gets no config file and no dependencies to restart on", () => {
  const { server, configFile, unwatched } = fakeServer();
  expect(server.config.configFileDependencies).toEqual([]);
  expect(unwatched).toEqual([configFile]);
});

test("a change to a file the config imports is told once", () => {
  const { dep, warnings, change } = fakeServer();
  change(dep);
  change(dep);
  change("/somewhere/else.ts");
  expect(warnings).toEqual([
    `Workbench: ${dep} changed. Stop and start the workbench to use the change.`,
  ]);
});

// Vite's watcher ignores the config file after unwatch, so it gets a watcher of its own.
test("a change to the config file itself is told once", async () => {
  const { configFile, warnings } = fakeServer();
  writeFileSync(configFile, "export default { server: {} };\n");
  await settle();
  writeFileSync(configFile, "export default {};\n");
  await settle();
  expect(warnings).toEqual([
    `Workbench: ${configFile} changed. Stop and start the workbench to use the change.`,
  ]);
});

test("after the server closed, a change to the config file is not told", async () => {
  const { configFile, warnings, close } = fakeServer();
  close();
  writeFileSync(configFile, "export default { server: {} };\n");
  await settle();
  expect(warnings).toEqual([]);
});
