import {
  createHermesBridge,
  type HermesBridge,
  type HermesBridgeConfig,
  type HermesCommandRunner,
} from "./bridge";

export type HermesBridgeServerConfig = HermesBridgeConfig & {
  host: string;
  port: number;
};

export type HermesBridgeServer = {
  server: ReturnType<typeof Bun.serve>;
  bridge: HermesBridge;
};

export async function startHermesBridge(
  config: HermesBridgeServerConfig,
  runner?: HermesCommandRunner,
): Promise<HermesBridgeServer> {
  if (!isLoopbackHost(config.host)) {
    throw new Error("Hermes bridge must bind to loopback.");
  }

  const bridge = createHermesBridge(config, runner);
  const readiness = await bridge.ready();
  if (!readiness.ok) {
    throw new Error("Hermes bridge roster readiness failed.");
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: Math.max(1, Math.ceil((config.timeoutMs ?? 30_000) / 1_000)),
    fetch: bridge.handle,
  });
  return { server, bridge };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}
