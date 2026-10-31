import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { SkillAgents } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  removeSkillMutationOptions,
  saveSkillMutationOptions,
} from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

export const Route = createFileRoute(
  "/_authed/_app/capabilities/skills_/$slug",
)({ component: EditSkillPage });

const BACK = {
  label: "Skills",
  linkProps: { to: "/capabilities/skills" as const },
};

/**
 * Editing a skill, on the same kind of screen that writes one.
 *
 * THERE IS NO EDIT ENDPOINT, AND NONE IS NEEDED. `POST /api/plugins/skills` upserts on the slug:
 * `installSkill` does `onConflictDoUpdate` and deliberately leaves `owner_user_id` alone, so a
 * re-save changes the words and never quietly changes whose skill it is. The route has already
 * refused anyone editing a skill that is not theirs before it gets that far.
 */
function EditSkillPage() {
  const { slug } = Route.useParams();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(pluginsPageQueryOptions());
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const removeSkill = useMutation(removeSkillMutationOptions(queryClient));
  const [deleting, setDeleting] = useState(false);
  const toList = () => navigate({ to: "/capabilities/skills" });

  /*
   * Read from the list rather than fetched on its own. Coming from the list it is already cached, so
   * the form is filled on the first frame instead of flashing empty fields at somebody who came here
   * to change one word.
   */
  const skill = data?.skills.find((candidate) => candidate.slug === slug);

  /* Nothing while it loads. "Missing" and "not yet arrived" must not read the same. */
  if (isPending) {
    return (
      <PageShell backButton={BACK} title="Edit skill">
        {null}
      </PageShell>
    );
  }

  /*
   * No list is not a missing skill. `isPending` goes false on a failed read too, and the sentence
   * below tells somebody their skill is gone, or was never theirs, on no evidence at all.
   *
   * Said plainly rather than shown as an empty form when it is missing. A skill can be missing
   * because it was deleted in another tab, or because the link names one that is somebody else's —
   * and an empty form here would invite them to write it back into existence under a slug they may
   * not own.
   */
  if (!data || !skill) {
    return (
      <PageShell backButton={BACK} title="Edit skill">
        {!data ? (
          <p className="text-destructive text-sm" role="alert">
            Couldn't load this skill. Reload the page.
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            This skill was deleted, or it isn't yours to edit.
          </p>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={BACK}
      description={
        <>
          Changes apply the next time someone uses <code>/{skill.slug}</code>.
          Bots that have it keep it.
        </>
      }
      title={skill.title}
    >
      <SkillFields
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
          // Defaulted, so a skill written before this field existed opens with nothing ticked rather
          // than with an undefined the form would refuse to submit.
          tools: skill.tools ?? [],
        }}
        /*
         * After the form and its Save button, because neither saves with it: a Bot's switch takes
         * effect the moment it is pressed, and deleting is a decision of its own. Below Save, they
         * cannot be mistaken for edits waiting on it.
         */
        afterForm={
          <>
            <SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />
            {/*
             * On the skill's own screen rather than in a menu on the list, so it is never one stray
             * press on the wrong row. Deleting is immediate and there is no undo, so it still asks
             * first, and the question names the command: that is what stops working.
             */}
            <PageSection
              description={
                <>
                  <code>/{skill.slug}</code> stops working on every Bot it is
                  on.
                </>
              }
              title="Delete"
            >
              <Button
                className="mt-4"
                onClick={() => setDeleting(true)}
                variant="destructive"
              >
                Delete skill
              </Button>
            </PageSection>
          </>
        }
        error={saveSkill.error}
        key={skill.slug}
        onCancel={toList}
        onSubmit={async (values) => {
          await saveSkill.mutateAsync(values);
          await toList();
        }}
        slugLocked
        submitLabel="Save changes"
      />

      <Dialog onOpenChange={setDeleting} open={deleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete /{skill.slug}?</DialogTitle>
            <DialogDescription>
              It stops working on every Bot it is on, and there is no undo.
            </DialogDescription>
          </DialogHeader>
          {removeSkill.error ? (
            <p className="text-destructive text-sm" role="alert">
              {removeSkill.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setDeleting(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={removeSkill.isPending}
              onClick={async () => {
                await removeSkill.mutateAsync(skill.slug);
                await toList();
              }}
              size="sm"
              variant="destructive"
            >
              {removeSkill.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
