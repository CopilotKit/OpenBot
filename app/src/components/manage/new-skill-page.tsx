import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import { useManagePaths } from "@/lib/manage-paths";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill for the whole deployment, on a screen of its own rather than in a dialog over the
 * list, as every other screen that adds something does (`new-credential-page.tsx`).
 *
 * Saving opens the skill's own page, because a skill no Bot offers does nothing yet: choosing the
 * Bots is the step that makes it work.
 */
export function NewSkillPage() {
  const paths = useManagePaths();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));

  return (
    <PageShell
      backButton={{ label: "Skills", linkProps: paths.skills() }}
      description="Write an instruction people run by typing / and its command. After saving, choose which Bots offer it."
      title="New skill"
    >
      <SkillFields
        card={{
          cancel: (
            <Button
              render={(props) => <Link {...props} {...paths.skills()} />}
              variant="outline"
            >
              Cancel
            </Button>
          ),
        }}
        defaultValues={emptySkillForm}
        error={saveSkill.error}
        onSubmit={async (values) => {
          // Admin-authored skills are the deployment's; a person's own are made on Capabilities.
          await saveSkill.mutateAsync({ ...values, global: true });
          await navigate(paths.skill(values.slug.trim()));
        }}
        submitLabel="Save skill"
      />
    </PageShell>
  );
}
