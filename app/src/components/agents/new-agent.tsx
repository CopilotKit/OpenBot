import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AgentFields } from "@/components/agents/agent-fields";
import { agentInputFrom, emptyAgentForm } from "@/lib/agents/form";
import { createAgentMutationOptions } from "@/lib/agents/mutations";

export function NewAgent() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createAgent = useMutation(createAgentMutationOptions(queryClient));

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">New coworker</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The role you write here applies in every channel this coworker works
          in.
        </p>
      </header>

      <AgentFields
        defaultValues={emptyAgentForm}
        error={createAgent.error}
        onSubmit={async (values) => {
          // The panel swaps from the form to the new coworker's profile, and the roster behind it
          // picks up the new card: the next thing to do is start a channel with it.
          const agent = await createAgent.mutateAsync(agentInputFrom(values));
          await navigate({ search: { agent: agent.id }, to: "/agents" });
        }}
        submitLabel="Create coworker"
      />
    </div>
  );
}
