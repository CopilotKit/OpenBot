import type { ConversationModel } from "@openbot/shared/conversation-model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { client } from "@/lib/client";
export function ModelSelector({
  channelId,
  agentId,
  disabled,
  onBlockingChange,
}: {
  channelId: string;
  agentId: string;
  disabled: boolean;
  onBlockingChange: (blocked: boolean) => void;
}) {
  const cache = useQueryClient();
  const queryKey = ["conversation-model", channelId, agentId];
  const path = `/api/channels/${encodeURIComponent(channelId)}/agents/${encodeURIComponent(agentId)}/model`;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      client<ConversationModel>(path, "model", { signal }),
    retry: false,
    refetchOnWindowFocus: "always",
  });
  const mutation = useMutation({
    mutationFn: (model: string | null) =>
      client<ConversationModel>(path, "model", {
        method: "PUT",
        body: { model },
      }),
    onMutate: async () => {
      await cache.cancelQueries({ queryKey });
    },
    onSuccess: async (model) => {
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(queryKey, model);
      onBlockingChange(model.selectionUnavailable);
    },
    onError: () =>
      onBlockingChange(!query.data || query.data.selectionUnavailable),
  });
  const data = query.data;
  const blocked = !data || mutation.isPending || !!data.selectionUnavailable;
  useEffect(() => {
    onBlockingChange(blocked);
  }, [blocked, onBlockingChange]);
  useEffect(() => () => onBlockingChange(false), [onBlockingChange]);
  if (!data)
    return query.isError ? (
      <span className="text-xs text-muted-foreground" role="status">
        Couldn't load models.{" "}
        <button
          type="button"
          className="underline"
          onClick={() => void query.refetch()}
        >
          Retry
        </button>
      </span>
    ) : (
      <span className="text-xs text-muted-foreground" role="status">
        Loading models…
      </span>
    );
  if (!data.selectable && !data.selectionUnavailable) return null;
  const effective = data.selectedModel ?? data.defaultModel;
  const label =
    data.options.find((m) => m.id === effective)?.label ??
    effective ??
    "Use Bot default";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        value={data.selectedModel ?? "__default"}
        disabled={disabled || mutation.isPending}
        onOpenChange={(open) => {
          if (open) void query.refetch();
        }}
        onValueChange={(value) => {
          if (value === null) return;
          onBlockingChange(true);
          mutation.mutate(value === "__default" ? null : value);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label="Model for this conversation"
          title="Model for this conversation"
          className="max-w-48 border-0 text-xs text-muted-foreground"
        >
          <span className="truncate">{label}</span>
        </SelectTrigger>
        <SelectContent
          className="w-max max-w-[calc(100vw-2rem)]"
          align="start"
          alignItemWithTrigger={false}
        >
          <SelectItem value="__default">
            Use Bot default
            {data.defaultModel
              ? ` (${data.options.find((m) => m.id === data.defaultModel)?.label ?? data.defaultModel})`
              : ""}
          </SelectItem>
          {data.selectable &&
            data.options.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {mutation.isError ? (
        <span role="alert" className="text-xs text-destructive">
          Couldn't change the model. Try again.
        </span>
      ) : data.selectionUnavailable ? (
        <span role="alert" className="text-xs text-destructive">
          This model isn't available. Choose another model.
        </span>
      ) : null}
    </div>
  );
}
