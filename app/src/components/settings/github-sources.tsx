import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createGithubBindingMutationOptions,
  githubBindingsQueryOptions,
  removeGithubBindingMutationOptions,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

const fieldClass = "grid gap-1 text-sm";

/**
 * The repositories whose GitHub events can start this person's responsibilities. One per person, not
 * per Bot: an event reaches every responsibility subscribed to it, whichever Bot holds it.
 */
export function GithubSources() {
  const formId = useId();
  const bindings = useQuery(githubBindingsQueryOptions());
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation(createGithubBindingMutationOptions(queryClient));
  const remove = useMutation(removeGithubBindingMutationOptions(queryClient));
  return (
    <PageSection
      description="Register a repository, then add its webhook in GitHub using the address below and the same secret. A responsibility can then start on one of its events, such as issues.opened."
      title="GitHub events"
    >
      <div className="mt-4 grid gap-3 rounded-lg border p-4">
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { repository, secret },
              {
                onSuccess: () => {
                  setSecret("");
                  setRepository("");
                },
              },
            );
          }}
        >
          <label className={fieldClass} htmlFor={`${formId}-repository`}>
            Repository
            <Input
              id={`${formId}-repository`}
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="owner/repository"
              required
            />
          </label>
          <label className={fieldClass} htmlFor={`${formId}-secret`}>
            Webhook secret
            <Input
              id={`${formId}-secret`}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              required
            />
          </label>
          <Button
            type="submit"
            className="self-end"
            disabled={create.isPending}
          >
            Connect events
          </Button>
        </form>
        {(bindings.error || create.error || remove.error) && (
          <p role="alert" className="text-destructive">
            {bindings.error?.message ??
              create.error?.message ??
              remove.error?.message}
          </p>
        )}
        {bindings.data?.map((binding) => (
          <div
            key={binding.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
          >
            <div>
              <p className="text-sm">{binding.repository}</p>
              <code className="break-all text-xs">
                {window.location.origin}/api/events/github/{binding.id}
              </code>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => remove.mutate(binding.id)}
            >
              Disconnect
            </Button>
          </div>
        ))}
      </div>
    </PageSection>
  );
}
