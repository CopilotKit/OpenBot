import { useCallback } from "react";
import { everyPage, ORGANIZATION_ID } from "../src/api";
import { listSkills } from "../src/api/generated/skills/skills";
import { authClient } from "../src/auth";
import { EmptyState, Notice, Row, Rows, ScrollScreen } from "../src/components";
import { IconBook } from "../src/icons";
import { useLoad } from "../src/use-load";
import { usePull } from "../src/use-pull";

/** Skills: what your Bots know how to do. Each is written or changed in OpenBot on your computer. */
export default function Skills() {
  const { data: session } = authClient.useSession();
  const load = useCallback(
    () =>
      everyPage(
        (page) => listSkills(ORGANIZATION_ID, page),
        (page) => page.skills,
      ),
    [],
  );
  const skills = useLoad(load, Boolean(session));
  const pull = usePull(skills.refresh);
  return (
    <ScrollScreen refreshing={pull.refreshing} onRefresh={pull.onRefresh}>
      <Notice message={skills.error} />
      {skills.data?.length ? (
        <Rows>
          {skills.data.map((skill) => (
            <Row
              key={skill.slug}
              icon={IconBook}
              title={skill.title}
              description={skill.summary || `/${skill.slug}`}
            />
          ))}
        </Rows>
      ) : skills.data ? (
        <EmptyState
          icon={IconBook}
          title="No skills yet"
          description="Write one in OpenBot on your computer, and your Bots can use it here too."
        />
      ) : null}
    </ScrollScreen>
  );
}
