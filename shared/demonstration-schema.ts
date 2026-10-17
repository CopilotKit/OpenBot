import { z } from "zod";
import {
  DEMONSTRATION_KEYS,
  isSafeDemonstrationUrl,
} from "./demonstration-rules";

const pageUrl = z.string().max(2000).refine(isSafeDemonstrationUrl);
const target = z
  .object({
    role: z.string().min(1).max(40),
    name: z.string().min(1).max(120),
    sensitive: z.boolean(),
  })
  .strict();
const gesture = z
  .object({
    kind: z.enum(["click", "type", "key", "scroll"]),
    url: pageUrl,
    target,
    key: z.enum(DEMONSTRATION_KEYS).optional(),
    deltaY: z.number().min(-2000).max(2000).optional(),
  })
  .strict();
const navigate = z
  .object({
    kind: z.literal("navigate"),
    url: pageUrl,
    transition: z.enum([
      "link",
      "typed",
      "reload",
      "back_forward",
      "history",
      "form_submit",
      "other",
    ]),
  })
  .strict();
const network = z
  .object({
    kind: z.literal("network"),
    url: pageUrl,
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    status: z.number().int().min(0).max(599),
  })
  .strict();
export const demonstrationActionSchema = z.union([gesture, navigate, network]);
export type DemonstrationAction = z.infer<typeof demonstrationActionSchema>;
export type DemonstrationGestureAction = z.infer<typeof gesture>;
/** Network steps exist only for state-changing requests; reads stay in the trajectory events. */
export const NETWORK_STEP_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
export function hasTarget(
  action: DemonstrationAction,
): action is DemonstrationGestureAction {
  return (
    action.kind === "click" ||
    action.kind === "type" ||
    action.kind === "key" ||
    action.kind === "scroll"
  );
}
