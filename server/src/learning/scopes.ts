import type {
  LearningSettings,
  LearningSource,
} from "@openbot/shared/learning";
import type { Edition } from "../edition";
import { personalLearningContainerId } from "./personal-space";

/**
 * The Learning spaces a person reviews: always their own, which their recordings join. The personal edition adds the
 * spaces its Bots learn into, since one person is the only reviewer there. A space named twice is listed once.
 */
export function learningScopes(input: {
  edition: Edition;
  userId: string;
  settings: LearningSettings;
}): LearningSource[] {
  const scopes: LearningSource[] = [
    {
      containerId: personalLearningContainerId(input.userId),
      kind: "recordings",
      label: "From your recordings",
    },
  ];
  if (input.edition === "personal") {
    const targets = [
      input.settings.defaultTarget,
      ...Object.values(input.settings.agents),
    ];
    for (const target of targets) {
      if (target) {
        scopes.push({
          containerId: target.containerId,
          kind: "conversations",
          label: "From your conversations",
        });
      }
    }
  }
  return scopes.filter(
    (scope, index) =>
      scopes.findIndex((s) => s.containerId === scope.containerId) === index,
  );
}
