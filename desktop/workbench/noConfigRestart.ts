// Workbench only. One Vite plugin for both workbench servers: desktop/vite.workbench.config.ts and
// app/vite.workbench.config.ts. No bare imports: the app's typecheck reads this file in a job
// that has no desktop install, so the server type below is the part of Vite's that it uses.

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
      if (configFile) server.watcher.unwatch(configFile);
      const told = new Set<string>();
      server.watcher.on("change", (file) => {
        if (!deps.includes(file) || told.has(file)) return;
        told.add(file);
        server.config.logger.warn(
          `Workbench: ${file} changed. Stop and start the workbench to use the change.`,
        );
      });
    },
  };
}
