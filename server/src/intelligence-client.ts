import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { IntelligenceSettings } from "./config";

/**
 * A client through which this deployment can ask Intelligence a question of its own.
 *
 * The runtime already holds one of these, built where it is mounted, and everything a conversation
 * does goes through that. This is for the questions OpenBot asks on its own account rather than on
 * a run's: whether a thread the browser remembers is still there, and whatever else later needs an
 * answer from the platform outside a turn.
 *
 * A second instance rather than a shared one, deliberately. The constructor stores its settings and
 * opens nothing — no socket, no handshake, no pool — so the cost is an object, while reaching into
 * the runtime for the client it built would tie this to the mounting order of a module that has no
 * other reason to care. The settings both read come from one place, which is the part that has to
 * agree.
 */
export function createIntelligenceClient(
  settings: IntelligenceSettings,
): CopilotKitIntelligence {
  return new CopilotKitIntelligence({
    apiUrl: settings.apiUrl,
    wsUrl: settings.gatewayWsUrl,
    apiKey: settings.apiKey,
  });
}
