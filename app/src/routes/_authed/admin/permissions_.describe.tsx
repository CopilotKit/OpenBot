import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  ChangeRows,
  PermissionsPreview,
} from "@/components/admin/controls/describe-capabilities";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { saveCapabilityChangesMutationOptions } from "@/lib/capability-changes/mutations";
import { capabilityChangesPreviewQueryOptions } from "@/lib/capability-changes/queries";
import {
  type CapabilityChange,
  type CapabilityTranslation,
  translateCapabilityChanges,
} from "@/lib/capability-changes/translate";
import { enterpriseOverviewQueryOptions } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/permissions_/describe")({
  component: DescribePermissionsPage,
});

const BACK = {
  label: "Permissions",
  linkProps: { to: "/admin/permissions" as const },
};

/** What came back for one description, kept beside the words it came from. */
type WrittenChanges = CapabilityTranslation & { text: string };

const same = (a: readonly CapabilityChange[], b: readonly CapabilityChange[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Who can do what, described in words, as team approval rules are on Describe team rules.
 *
 * The model's switch changes land as rows the admin can remove, beside an independent reading of them
 * and whether they check. Who they would change is worked out on the server for every member, with
 * the recent use of what anybody would lose. Only Save writes them, together, with the sentence they
 * were written from.
 */
function DescribePermissionsPage() {
  const navigate = Route.useNavigate();
  const save = useMutation(saveCapabilityChangesMutationOptions(queryClient));
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const [written, setWritten] = useState<WrittenChanges | null>(null);
  const [changes, setChanges] = useState<CapabilityChange[]>([]);

  const preview = useQuery({
    ...capabilityChangesPreviewQueryOptions(changes),
    enabled: changes.length > 0,
    // The last answer stays up while the next loads, so the list does not blink after a removal.
    placeholderData: keepPreviousData,
  });
  /* The check of the changes on screen now, and not of the ones before a removal still loading. */
  const current =
    preview.data && !preview.isPlaceholderData ? preview.data : null;
  const ready = Boolean(current?.check.ok) && changes.length > 0;
  const edited = written !== null && !same(changes, written.changes);
  const titles = Object.fromEntries(
    (overview.data?.capabilities ?? []).map((capability) => [
      capability.capability,
      capability.title,
    ]),
  );

  const saveChanges = () => {
    if (!ready) return;
    save.mutate(
      {
        changes,
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      { onSuccess: () => void navigate({ to: "/admin/permissions" }) },
    );
  };

  return (
    <PageShell
      backButton={BACK}
      description="Say who may use what, and your model writes the permission changes. Nothing changes until you save them."
      title="Describe who can do what"
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          saveChanges();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} to="/admin/permissions" />}
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={!ready || save.isPending} type="submit">
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <FieldGroup>
            <DescribeField
              action="Write changes"
              description="Say in a sentence who may or may not do something, and your model writes the changes from this OpenBot's roles and groups. A second reading that never sees your words says what the changes do."
              id="permissions-english"
              label="Describe the change"
              placeholder="Contractors can't use their own computer"
              write={async (described) => {
                const translation = await translateCapabilityChanges(described);
                save.reset();
                setWritten({ ...translation, text: described });
                setChanges(translation.changes);
                return null;
              }}
            />
            {written ? (
              <ReadingStatus
                check={written.check}
                edited={
                  edited
                    ? "You've removed a change since they were written. The check and the reading above are for the written changes, not your edit."
                    : null
                }
                explanation={written.explanation}
                failed={
                  // No changes says so itself, with the model's reason.
                  written.changes.length === 0
                    ? ""
                    : "These changes don't check, so OpenBot won't save them."
                }
                heading="What these changes do"
                passed="Checks. Every change names a permission, role or group this OpenBot has."
                warning={written.warning}
              />
            ) : null}
            {changes.length > 0 ? (
              <ChangeRows
                changes={changes}
                onRemove={(index) =>
                  setChanges(changes.filter((_, at) => at !== index))
                }
                problems={
                  current && !current.check.ok ? current.check.problems : []
                }
                titles={titles}
              />
            ) : null}
            {current &&
            !current.check.ok &&
            current.check.problems.length === 0 ? (
              <p className="text-destructive text-sm">{current.check.error}</p>
            ) : null}
            {changes.length > 0 ? (
              <PermissionsPreview preview={preview} />
            ) : null}
          </FieldGroup>
          {save.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}
