import { IconUsersGroup } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { TeamPage } from "@/components/edition/for-a-team";
import { PageCard, PageEmpty, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  NO_PARENT,
  type TeamFormValues,
  teamFormSchema,
  teamInputFrom,
} from "@/lib/teams/form";
import { createTeamMutationOptions } from "@/lib/teams/mutations";
import { possibleParents, teamListQueryOptions } from "@/lib/teams/queries";
import { queryClient } from "@/query-client";
import {
  backToTeams,
  type TeamPaths,
  type TeamsShell,
  teamPaths,
} from "./team-paths";
import { failureSaid } from "@/lib/load-failure";

const DESCRIPTION = "Name the team. You add its people on the next screen.";

/** What the parent Select shows for each value: without it the trigger would draw a team's id. */
export function parentLabels(
  teams: readonly { id: string; name: string }[],
): Record<string, string> {
  return {
    [NO_PARENT]: "None",
    ...Object.fromEntries(teams.map((team) => [team.id, team.name])),
  };
}

/**
 * Creating a team, on a screen of its own reached from the list's New team. On success the person
 * lands on the new team's page, where its people are added.
 */
function NewTeam({ paths }: { paths: TeamPaths }) {
  const back = backToTeams(paths);
  const navigate = useNavigate();
  const list = useQuery(teamListQueryOptions());
  const createTeam = useMutation(createTeamMutationOptions(queryClient));
  const parents = possibleParents(list.data?.teams ?? []);
  const defaultValues: TeamFormValues = {
    name: "",
    description: "",
    parentTeamId: NO_PARENT,
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: teamFormSchema },
    onSubmit: async ({ value }) => {
      const team = await createTeam.mutateAsync(teamInputFrom(value));
      await navigate(paths.team(team.id));
    },
  });

  // Reached by its address by somebody the server would refuse: say so before they fill it in.
  if (list.data && !list.data.canCreate) {
    return (
      <PageShell backButton={back} title="New team">
        <PageEmpty
          icon={IconUsersGroup}
          title="Only an admin can create a team"
        >
          Ask an admin of your organization to create it.
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell backButton={back} description={DESCRIPTION} title="New team">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit().catch(() => undefined);
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} {...paths.list()} />}
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={createTeam.isPending} type="submit">
                {createTeam.isPending ? "Creating…" : "Create team"}
              </Button>
            </>
          }
        >
          <FieldGroup>
            <form.Field name="name">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      autoComplete="off"
                      id={field.name}
                      maxLength={100}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="Sales"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="description">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Description</FieldLabel>
                    <FieldDescription>
                      Say what the team is for. You can leave this empty.
                    </FieldDescription>
                    <Textarea
                      aria-invalid={isInvalid}
                      className="min-h-20"
                      id={field.name}
                      maxLength={500}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
            {/* Offered once there is a team to put this one under. */}
            {parents.length > 0 ? (
              <form.Field name="parentTeamId">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Parent team</FieldLabel>
                    <FieldDescription>
                      People in this team can also use everything the parent
                      team is given.
                    </FieldDescription>
                    <Select
                      items={parentLabels(parents)}
                      onValueChange={(value) =>
                        field.handleChange(String(value))
                      }
                      value={field.state.value}
                    >
                      <SelectTrigger className="w-full" id={field.name}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NO_PARENT}>None</SelectItem>
                          {parents.map((team) => (
                            <SelectItem key={team.id} value={team.id}>
                              {team.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </form.Field>
            ) : null}
          </FieldGroup>
          {createTeam.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {failureSaid(createTeam.error)}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}

/**
 * The personal edition shows this page's title, and that it applies to a team. `shell` is the frame
 * it is drawn in, so Cancel, the back button and the new team's page stay in it.
 */
export function NewTeamPage({ shell = "app" }: { shell?: TeamsShell } = {}) {
  const paths = teamPaths(shell);
  return (
    <TeamPage
      backButton={backToTeams(paths)}
      description={DESCRIPTION}
      title="New team"
    >
      <NewTeam paths={paths} />
    </TeamPage>
  );
}
