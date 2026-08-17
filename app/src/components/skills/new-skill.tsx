import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SkillFields } from "@/components/skills/skill-fields";
import { pluginKeys } from "@/lib/plugins/queries";
import { emptySkillForm, type SkillFormValues } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 */
export function NewSkill() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const createSkill = useMutation({
    mutationFn: async (values: SkillFormValues) => {
      const response = await fetch("/api/plugins/skills", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        /*
         * The server's sentence, not one invented here. It refuses for reasons this form cannot
         * check — a slug somebody else already owns is the common one — and paraphrasing that into
         * "That did not work" would throw away the only part worth reading.
         */
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "The skill could not be saved.");
      }
      return response.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.all }),
  });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">New skill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A named instruction you invoke with <code>/</code>. It goes on the
          Bots you own, and nobody else sees it.
        </p>
      </header>

      <SkillFields
        defaultValues={emptySkillForm}
        error={createSkill.error}
        onSubmit={async (values) => {
          await createSkill.mutateAsync(values);
          // Panel closed rather than swapped for a detail view: there is nothing more to say about a
          // skill than the form just said, and the new row is already behind it in the list.
          await navigate({ search: {}, to: "/skills" });
        }}
        submitLabel="Save skill"
      />
    </div>
  );
}
