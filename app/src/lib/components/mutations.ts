import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  allowBotComponent,
  deleteComponent,
  grantComponentFunction,
  publishComponent,
  replaceComponentDraft,
  revokeComponentFunction,
  unpublishComponent,
  withholdBotComponent,
} from "@/lib/api/generated/components/components";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { type ComponentRecord, componentKeys } from "./queries";

/**
 * Writes against a component's governance: publication, per-Bot grants, per-function grants, the
 * draft, and a Playground component's source.
 *
 * Every one of these is a decision the server records and may refuse, so none of them patch the
 * cache — the list is invalidated and the screen re-reads whatever was actually decided.
 */

/** The sentence for every write here, for the rare case the server sends none of its own. */
const FALLBACK = "Component operation failed";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateComponents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: componentKeys.all });
}

const key = () => ({ "Idempotency-Key": idempotencyKey() });

/**
 * Whether one Bot may answer with a component.
 *
 * Allowing it and holding it back are the two answers; there is no third state to send.
 */
export function setComponentGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      agentId: string;
      granted: boolean;
    }) => {
      await (variables.granted ? allowBotComponent : withholdBotComponent)(
        ORGANIZATION_ID,
        variables.agentId,
        variables.name,
        key(),
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/** Whether a component may read one deployment data function. */
export function setComponentFunctionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      functionName: string;
      granted: boolean;
    }) => {
      await (variables.granted
        ? grantComponentFunction
        : revokeComponentFunction)(
        ORGANIZATION_ID,
        variables.name,
        variables.functionName,
        key(),
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/** Whether any Bot is told the component exists. */
export function setComponentPublishedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { name: string; published: boolean }) => {
      await (variables.published ? publishComponent : unpublishComponent)(
        ORGANIZATION_ID,
        variables.name,
        key(),
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/**
 * The description the model will read once it is published. Saving it changes nothing a Bot can see
 * until publication, which is why it is a separate write.
 *
 * A Playground component's draft is its title, description and source together, so its title and
 * source go with the new description, as they stand.
 */
export function saveComponentDraftMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      component: Pick<ComponentRecord, "name" | "title" | "draftSource">;
      description: string;
    }) => {
      const { component, description } = variables;
      await replaceComponentDraft(
        ORGANIZATION_ID,
        component.name,
        component.draftSource
          ? {
              title: component.title,
              description,
              source: component.draftSource,
            }
          : { description },
        key(),
        { fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/**
 * A component written in Playground, as the playground sends it.
 *
 * `argumentSchema` and `sampleArguments` arrive parsed. The playground holds them as text while
 * somebody is typing, and text that does not parse is not a draft the server should be asked to
 * store — so parsing is the editor's job and this is what survives it.
 */
export type PlaygroundDraftInput = {
  slug: string;
  title: string;
  description: string;
  html: string;
  css: string;
  jsFunctions: string;
  argumentSchema: Record<string, unknown>;
  sampleArguments: Record<string, unknown>;
};

const PLAYGROUND_FALLBACK = "That did not work.";

/** The name the server knows a Playground component by. */
export function playgroundName(slug: string): string {
  return `custom_${slug}`;
}

/** Save the draft on screen, which makes the component the first time it is saved. */
async function savePlaygroundDraft(input: PlaygroundDraftInput) {
  await replaceComponentDraft(
    ORGANIZATION_ID,
    playgroundName(input.slug),
    {
      title: input.title,
      description: input.description,
      source: {
        html: input.html,
        css: input.css,
        jsFunctions: input.jsFunctions,
        argumentSchema: input.argumentSchema,
        sampleArguments: input.sampleArguments,
      },
    },
    key(),
    { fallback: PLAYGROUND_FALLBACK },
  );
}

export function savePlaygroundDraftMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: savePlaygroundDraft,
    onSuccess: () => invalidateComponents(queryClient),
  });
}

/**
 * Publish what is on screen.
 *
 * Saves first, in the same mutation, because publishing acts on the stored draft rather than on the
 * editors. Two calls rather than one, so a save that fails stops the publish — publishing a draft
 * the server never received would put something on screen that nobody wrote.
 */
export function publishPlaygroundMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: PlaygroundDraftInput) => {
      await savePlaygroundDraft(input);
      await publishComponent(
        ORGANIZATION_ID,
        playgroundName(input.slug),
        key(),
        { fallback: PLAYGROUND_FALLBACK },
      );
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}

export function deletePlaygroundComponentMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (name: string) => {
      await deleteComponent(ORGANIZATION_ID, name, key(), {
        fallback: PLAYGROUND_FALLBACK,
      });
    },
    onSuccess: () => invalidateComponents(queryClient),
  });
}
