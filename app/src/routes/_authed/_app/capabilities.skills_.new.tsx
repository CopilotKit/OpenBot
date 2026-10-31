import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { SkillBotPicks } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import {
  grantPlugin,
  invalidatePlugins,
  saveSkillMutationOptions,
} from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

export const Route = createFileRoute("/_authed/_app/capabilities/skills_/new")({
  component: NewSkillPage,
});

const BACK = {
  label: "Skills",
  linkProps: { to: "/capabilities/skills" as const },
};

/**
 * Writing a skill, on a screen of its own rather than over the list.
 *
 * Its own address so the form has a page's room — the instructions are the part that grows, and the
 * tools step can list eighty of an app's tools — plus a back button and a URL that can be linked to,
 * which is how adding a credential works too.
 */
function NewSkillPage() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const createSkill = useMutation(saveSkillMutationOptions(queryClient));
  /*
   * The Bots to put it on once it exists. Held here rather than in the form, because they are not
   * part of the skill: they are grants, made one by one after the skill is saved.
   */
  const [bots, setBots] = useState<string[]>([]);

  return (
    <PageShell
      backButton={BACK}
      description={
        <>
          An instruction you start with <code>/</code>. Only you see it, and it
          works on Bots you own.
        </>
      }
      title="New skill"
    >
      <SkillFields
        beforeActions={<SkillBotPicks onChange={setBots} picked={bots} />}
        defaultValues={emptySkillForm}
        error={createSkill.error}
        onCancel={() => navigate({ to: "/capabilities/skills" })}
        onSubmit={async (values) => {
          await createSkill.mutateAsync(values);
          /*
           * The skill is saved before any Bot is asked to carry it, so a grant that fails cannot
           * lose the skill. If one does, the skill's own screen is where its switches show what
           * actually stuck and the rest can be switched on again; otherwise, back to the list.
           */
          const granted = await Promise.allSettled(
            bots.map((agentId) =>
              grantPlugin({ agentId, kind: "skill", ref: values.slug }),
            ),
          );
          if (bots.length > 0) await invalidatePlugins(queryClient);
          if (granted.some((result) => result.status === "rejected")) {
            await navigate({
              params: { slug: values.slug },
              to: "/capabilities/skills/$slug",
            });
            return;
          }
          await navigate({ to: "/capabilities/skills" });
        }}
        submitLabel="Create skill"
      />
    </PageShell>
  );
}
