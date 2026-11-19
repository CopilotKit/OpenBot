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

/** An error message keeps its first 300 characters, but reading stops well before a huge body. */
const MAX_ERROR_BODY_BYTES = 4096;
/** A reply carries at most one 256 KiB release manifest and 32 commands; 1 MiB is generous. */
const MAX_REPLY_BODY_BYTES = 1024 * 1024;

/** Read at most `limit` bytes from a response, so a hostile body cannot fill the agent's memory. */
async function boundedText(response: Response, limit: number) {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(
          `response body is larger than ${limit} bytes; refusing to read it`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

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
        `${path} answered ${response.status}: ${(
          await boundedText(response, MAX_ERROR_BODY_BYTES)
        ).slice(0, 300)}`,
      );
    return response;
  }

  async heartbeat(heartbeat: Heartbeat) {
    const response = await this.post(HEARTBEAT_PATH, heartbeat);
    return HeartbeatReplyWire.parse(
      JSON.parse(await boundedText(response, MAX_REPLY_BODY_BYTES)),
    );
  }

  async result(result: CommandResult) {
    await this.post(commandResultPath(result.commandId), result);
  }
}
