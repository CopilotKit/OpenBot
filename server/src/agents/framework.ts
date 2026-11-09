/**
 * Which agent framework a Bot runs on, by what runs it rather than by what its subtitle says.
 *
 * The subtitle ("Everyday life. Powered by LangChain.") is the person's to write, and a
 * Bot told only that could name its framework only while the subtitle happened to. So the answer is
 * read from the Bot itself:
 *
 * - a Bot that runs here runs on OpenBot;
 * - the harness picked in setup runs the image this deployment started for it (`PICKED_HARNESS_IMAGE`),
 *   unless somebody brought it themselves (`PICKED_HARNESS_SOURCE=byo`);
 * - an agent somebody runs at their own address runs on the framework they named when they connected
 *   it (`configuration.harness`, from New Bot).
 *
 * Anything else, such as an agent connected by address with no framework named, has no answer here,
 * and the Bot is told none rather than a guess.
 */
import {
  declaredHarness,
  harnessForImage,
  OPENBOT_HARNESS_NAME,
} from "@openbot/shared/harnesses";

const trimmed = (url: string) => url.trim().replace(/\/+$/, "");

export function frameworkOf(
  agent: {
    type: "built_in" | "remote_ag_ui" | "remote_mastra";
    configuration: unknown;
  },
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  if (agent.type === "built_in") return OPENBOT_HARNESS_NAME;
  const configuration =
    agent.configuration && typeof agent.configuration === "object"
      ? (agent.configuration as Record<string, unknown>)
      : {};
  const endpoint =
    typeof configuration.endpoint === "string" ? configuration.endpoint : "";
  const picked = environment.PICKED_HARNESS_URL?.trim();
  if (
    endpoint &&
    picked &&
    trimmed(endpoint) === trimmed(picked) &&
    environment.PICKED_HARNESS_SOURCE?.trim() !== "byo"
  ) {
    const running = harnessForImage(environment.PICKED_HARNESS_IMAGE ?? "");
    if (running) return running.name;
  }
  return declaredHarness(configuration.harness)?.name;
}
