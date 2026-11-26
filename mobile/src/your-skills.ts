/**
 * What Skills and a skill's screen need beside the skills themselves to say who may change one (./skill-form.ts):
 * the signed-in person's id as the API names owners, and this OpenBot's edition.
 */
import { ME, ORGANIZATION_ID, readDeployment } from "./api";
import { getPerson } from "./api/generated/people/people";

export type SkillChanger = {
  personId: string | undefined;
  edition: string | undefined;
};

/**
 * Who is asking, and in which edition. `sessionId` is the session's own id, used when the person can't be read; an
 * edition that can't be read is unknown, which offers only the person's own skills.
 */
export async function whoChangesSkills(
  sessionId: string | undefined,
): Promise<SkillChanger> {
  // Kept for the same session, since the lists that ask read again every few seconds. One that couldn't be read whole
  // isn't kept.
  if (kept && kept.sessionId === sessionId) return kept.who;
  const [person, deployment] = await Promise.all([
    getPerson(ORGANIZATION_ID, ME).catch(() => undefined),
    readDeployment(true).catch(() => undefined),
  ]);
  const who = {
    personId: person?.person.id ?? sessionId,
    edition: deployment?.edition,
  };
  if (person && deployment) kept = { sessionId, who };
  return who;
}
let kept: { sessionId: string | undefined; who: SkillChanger } | undefined;
