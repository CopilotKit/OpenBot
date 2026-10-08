type Peek = {
  status: "pending" | "error" | "success";
  data?: { title: string };
};
type Confirm = {
  status: "idle" | "pending" | "error" | "success";
  hint?: string | null;
};
export type ConfirmLinkState = {
  kind:
    | "invalid"
    | "loading"
    | "expired"
    | "ready"
    | "confirming"
    | "failed"
    | "done";
  title?: string;
  hint?: string | null;
};

/** What the confirm page draws, from the token and its two requests. Pure, so it is tested alone. */
export function confirmLinkState(input: {
  token: string | undefined;
  peek: Peek;
  confirm: Confirm;
}): ConfirmLinkState {
  if (!input.token || !/^[A-Za-z0-9_-]{43}$/.test(input.token))
    return { kind: "invalid" };
  // A confirmed link stays done: the challenge is spent, so a later peek refetch would only 404.
  if (input.confirm.status === "success")
    return {
      kind: "done",
      title: input.peek.data?.title,
      hint: input.confirm.hint ?? null,
    };
  if (input.peek.status === "pending") return { kind: "loading" };
  if (input.peek.status === "error" || !input.peek.data)
    return { kind: "expired" };
  const title = input.peek.data.title;
  switch (input.confirm.status) {
    case "pending":
      return { kind: "confirming" };
    case "error":
      return { kind: "failed" };
    default:
      return { kind: "ready", title };
  }
}
