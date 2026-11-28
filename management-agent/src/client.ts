/**
 * The agent's only connection out: HTTPS to the management service with the install's client
 * certificate. Every call is started here; nothing listens for the service in the cluster.
 */
import {
  type CommandResult,
  commandResultPath,
  HEARTBEAT_PATH,
  type Heartbeat,
  HeartbeatReplyWire,
} from "../../shared/management-contract";
import type { Credentials } from "./config";

export class ManagementClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credentials: Credentials,
    private readonly timeoutMs = 20_000,
  ) {}

  private async post(path: string, body: unknown) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      tls: {
        cert: this.credentials.cert,
        key: this.credentials.key,
        ...(this.credentials.ca ? { ca: this.credentials.ca } : {}),
      },
    });
    if (!response.ok)
      throw new Error(
        `${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    return response;
  }

  async heartbeat(heartbeat: Heartbeat) {
    const response = await this.post(HEARTBEAT_PATH, heartbeat);
    return HeartbeatReplyWire.parse(await response.json());
  }

  async result(result: CommandResult) {
    await this.post(commandResultPath(result.commandId), result);
  }
}
