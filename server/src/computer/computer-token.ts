/**
 * Which token a call to a computer carries.
 *
 * A computer that a provider made for one person, or for one isolated Bot, holds a token of its own,
 * derived from the deployment's `COMPUTER_TOKEN` and whose computer it is (shared/computer-token.ts),
 * so a Bot that reads its own computer's token off its own process opens no other computer. The
 * supervisor and the sandbox provider make computers that way and say so (`tokenFor`). The one
 * computer everybody shares holds the deployment's token, as does OpenBot Desktop's host-side
 * browser computer, which runs people's own browsers and no Bot.
 *
 * NEVER THE DEPLOYMENT'S TOKEN TO A COMPUTER THAT HOLDS ITS OWN. A Bot is root on its own computer
 * and can read what that computer's process is sent, so a call carrying the deployment's token would
 * hand the Bot the key the derivation exists to keep from it. Every call to a computer asks here.
 */
import { computerTokenFor } from "@openbot/shared/computer-token";
import type { ComputerKey } from "./computer-key";
import type { ComputerProvider } from "./provider";

/** The token of a computer made for `key` alone: a person's, an isolated Bot's, a person's own browser's. */
export function ownComputerToken(
  deploymentToken: string,
  key: ComputerKey,
): string {
  return computerTokenFor(
    deploymentToken,
    key.kind === "person"
      ? { kind: "person", id: key.personId }
      : { kind: "bot", id: key.botId },
  );
}

/**
 * The token the computer `key` names takes, on this provider.
 *
 * Undefined where the deployment set no token, which is a computer with no door (the computer refuses
 * to start without one). A provider that says nothing holds the deployment's token, which is what the
 * one shared computer does.
 */
export function computerTokenOf(
  provider: Pick<ComputerProvider, "tokenFor">,
  key: ComputerKey,
  deploymentToken: string | undefined,
): string | undefined {
  if (!deploymentToken) return undefined;
  return provider.tokenFor
    ? provider.tokenFor(key, deploymentToken)
    : deploymentToken;
}
