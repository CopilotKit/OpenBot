import {
  type HermesBridgeServer,
  startHermesBridge,
  type HermesBridgeServerConfig,
} from "./server";
import {
  loadHermesBridgeConfig,
  type BridgeEnvironment,
} from "./config";
import type { HermesCommandRunner } from "./bridge";

export function startHermesBridgeFromEnv(
  environment: BridgeEnvironment = process.env,
  runner?: HermesCommandRunner,
): Promise<HermesBridgeServer> {
  const config: HermesBridgeServerConfig = loadHermesBridgeConfig(environment);
  return startHermesBridge(config, runner);
}
