// What CopilotKit's own client reads from the same bytes: @ag-ui/client 1.0.2's transformHttpEventStream (the parser
// CopilotKit's ProxiedCopilotRuntimeAgent and AG-UI's HttpAgent run every response through, SSE or protobuf by its
// content type), and phoenix 1.8's own V2 serializer for a channel's frames. The tests hold the capture to these.
import { transformHttpEventStream } from "@ag-ui/client";
import * as phoenix from "phoenix";

type Decoded = { topic: string; event: string; payload: unknown };
/** phoenix 1.8 exports its serializer; @types/phoenix 1.6 does not describe it. */
const { Serializer } = phoenix as unknown as {
  Serializer: {
    decode(text: string, callback: (message: Decoded) => void): void;
  };
};

/** The events @ag-ui/client parses from one response's bytes. */
export function clientEvents(
  contentType: string,
  bytes: Uint8Array,
): Promise<Record<string, unknown>[]> {
  // The source is only subscribed to: emitting after subscribe returns, as an HTTP response's reader does.
  const source = {
    subscribe(observer: { next(event: unknown): void; complete(): void }) {
      setTimeout(() => {
        observer.next({
          type: "headers",
          status: 200,
          headers: new Headers({ "content-type": contentType }),
        });
        observer.next({ type: "data", data: bytes });
        observer.complete();
      }, 0);
      return { unsubscribe() {} };
    },
  };
  return new Promise((resolve, reject) => {
    const out: Record<string, unknown>[] = [];
    transformHttpEventStream(
      source as unknown as Parameters<typeof transformHttpEventStream>[0],
    ).subscribe({
      next: (event) => out.push(event as unknown as Record<string, unknown>),
      error: reject,
      complete: () => resolve(out),
    });
  });
}

/** A Phoenix V2 text frame as phoenix.js decodes it. */
export function phoenixFrame(text: string): Decoded {
  let message: Decoded | undefined;
  Serializer.decode(text, (decoded) => {
    message = decoded;
  });
  if (!message) throw new Error("phoenix.js decoded nothing");
  return message;
}
