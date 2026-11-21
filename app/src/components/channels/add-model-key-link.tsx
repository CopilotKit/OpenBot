import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { isOrganizationAdmin } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

/**
 * What the server says when a Bot has no model key to answer with, word for word (the server's
 * `NO_AI_CONNECTION`). An organization that brings its own key, as every one on OpenBot Cloud does,
 * reads it on its first message.
 */
export const NO_AI_CONNECTION =
  "This organization doesn't have an AI connection yet. An admin can add a model key in Admin, under Vault.";

/** Where an admin adds the key: a new credential in Admin, under Vault. */
export const ADD_MODEL_KEY_PATH = "/admin/credentials/new";

/**
 * Add a model key, beside the sentence that says there is none: where the admin already is when
 * they find out. Only for an admin of the organization; a member reads the sentence, which tells
 * them who to ask. Named query client, as everything drawn inside a conversation.
 */
export function AddModelKeyLink({ reason }: { reason: string }) {
  const me = useQuery(
    { ...currentUserQueryOptions(), enabled: reason === NO_AI_CONNECTION },
    queryClient,
  ).data;
  if (reason !== NO_AI_CONNECTION || !isOrganizationAdmin(me?.role))
    return null;
  return (
    <a
      className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
      href={ADD_MODEL_KEY_PATH}
    >
      Add a model key
    </a>
  );
}
