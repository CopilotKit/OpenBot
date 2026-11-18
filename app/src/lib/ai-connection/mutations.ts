import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import type {
  AiConnection,
  AiConnectionInput,
} from "@/lib/api/generated/model";
import {
  getAiConnection,
  replaceAiConnection,
} from "@/lib/api/generated/models/models";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { desktopKeys } from "@/lib/desktop/queries";
import { modelKeys } from "@/lib/models/queries";
import { prepareAiConnection, settleAiConnection } from "./desktop";
import { aiConnectionKeys } from "./queries";

const FALLBACK = "Couldn't change the AI connection. Try again.";

/** Where the switch is, for the button that started it to say. */
export type ConnectPhase = "starting" | "checking" | "finishing";

export type ConnectVariables = {
  input: AiConnectionInput;
  /** In an OpenBot Desktop that changes the connection in place: it starts and settles engines. */
  desktop: boolean;
  onPhase?: (phase: ConnectPhase) => void;
};

/** What a switch ends with: the connection in use, and anything Desktop couldn't finish after it. */
export type Connected = {
  connection: AiConnection;
  /** Desktop's sentence when it couldn't record the switch or move the default Bot. */
  desktopProblem: string | null;
};

/**
 * Switch the AI connection with no restart. The server checks it with the provider before it saves
 * anything; a refusal throws its one sentence and the connection in use keeps running.
 *
 * In Desktop the order is the contract's: a plan's engine starts first (prepare), then the server
 * switches, then Desktop settles to it. When anything before the switch fails, Desktop settles back
 * to the connection the server still reports, which stops whatever prepare started.
 */
export async function connectAi({
  input,
  desktop,
  onPhase,
}: ConnectVariables): Promise<Connected> {
  try {
    if (desktop && input.login === "plan") {
      onPhase?.("starting");
      await prepareAiConnection(input.provider, input.login);
    }
    onPhase?.("checking");
    const connection = await replaceAiConnection(
      organizationId(),
      input,
      { "Idempotency-Key": idempotencyKey() },
      { fallback: FALLBACK },
    );
    let desktopProblem: string | null = null;
    if (desktop && connection.provider && connection.login) {
      onPhase?.("finishing");
      try {
        await settleAiConnection({
          provider: connection.provider,
          login: connection.login,
          model: connection.model,
          endpointHost: connection.endpointHost,
        });
      } catch (error) {
        desktopProblem =
          error instanceof Error
            ? error.message
            : "OpenBot Desktop couldn't finish the switch.";
      }
    }
    return { connection, desktopProblem };
  } catch (error) {
    if (desktop) await settleBack();
    throw error;
  }
}

/** Desktop back on the connection the server still uses. Best effort: the refusal is the news. */
async function settleBack() {
  try {
    const current = await getAiConnection(organizationId());
    if (current.provider && current.login)
      await settleAiConnection({
        provider: current.provider,
        login: current.login,
        model: current.model,
        endpointHost: current.endpointHost,
      });
  } catch {
    // Nothing to put back, or Desktop can't say: the person reads the refusal either way.
  }
}

/**
 * The switch, for a dialog. On success the connection, the model catalogue (which provider's models
 * a person may pick) and every conversation's model choice are read again, since a pick the new
 * provider doesn't offer is now set aside.
 */
export function connectAiMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: ConnectVariables) => connectAi(variables),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: aiConnectionKeys.all }),
        queryClient.invalidateQueries({ queryKey: modelKeys.all }),
        queryClient.invalidateQueries({ queryKey: desktopKeys.aiConnection }),
      ]),
  });
}
