// Workbench only. One Vite plugin for both workbench servers: desktop/vite.workbench.config.ts and
// app/vite.workbench.config.ts. No package imports (Node's own modules only): the app's typecheck
// reads this file in a job that has no desktop install, so the server type below is the part of
// Vite's that it uses.
import { type FSWatcher, watch } from "node:fs";

/** The part of Vite's dev server that the plugin uses. */
type WatchedServer = {
  config: {
    configFile?: string;
    configFileDependencies: string[];
    logger: { warn(message: string): void };
  };
  watcher: {
    unwatch(path: string): unknown;
    on(event: "change", listener: (file: string) => void): unknown;
  };
  httpServer?: { once(event: "close", listener: () => void): unknown } | null;
};

/**
 * Vite restarts the server when the config file or a file it imports changes. A restart closes the
 * port for a moment (and, for the workbench server, stops and starts the app server), so the runs
 * of other processes that share the server fail (ERR_CONNECTION_REFUSED, then 502 on /__app/ until
 * the app is back). The server keeps its config instead and says once that a restart is needed.
 * The imported files still get normal HMR: appContract.ts, for example, is also a module of the
 * page.
 */
export function noConfigRestart() {
  return {
    name: "workbench-no-config-restart",
    apply: "serve" as const,
    configureServer(server: WatchedServer) {
      const configFile = server.config.configFile;
      const deps = [...server.config.configFileDependencies];
      server.config.configFileDependencies.length = 0;
      const told = new Set<string>();
      const tell = (file: string) => {
        if (told.has(file)) return;
        told.add(file);
        server.config.logger.warn(
          `Workbench: ${file} changed. Stop and start the workbench to use the change.`,
        );
      };
      server.watcher.on("change", (file) => {
        if (file !== configFile && deps.includes(file)) tell(file);
      });
      if (!configFile) return;
      // Vite restarts on any change event for the config file, so its watcher must not see the file
      // (unwatch also makes the watcher ignore it). That also means no change event reaches the
      // listener above: the file gets a watcher of its own, which only tells. It closes after the
      // first change (one notice is enough; an editor's save by rename also ends a file watch) and
      // when the server closes.
      server.watcher.unwatch(configFile);
      let own: FSWatcher | null = null;
      const close = () => {
        own?.close();
        own = null;
      };
      try {
        own = watch(configFile, () => {
          close();
          tell(configFile);
        });
        own.on("error", close);
        // It never keeps the process up on its own.
        own.unref();
      } catch {
        return;
      }
      server.httpServer?.once("close", close);
    },
  };
}
