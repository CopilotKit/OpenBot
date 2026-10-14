import {
  IconBook2,
  IconLoader2,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import {
  createDocumentMutationOptions,
  deleteDocumentMutationOptions,
  updateDocumentMutationOptions,
} from "@/lib/documents/mutations";
import {
  documentQueryOptions,
  documentsQueryOptions,
  type KnowledgeDocument,
} from "@/lib/documents/queries";

export const Route = createFileRoute("/_authed/_app/documents")({
  component: DocumentsPage,
});

type Mode =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "view"; id: string }
  | { kind: "edit"; id: string };

function DocumentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery(documentsQueryOptions(search));
  const detailId = mode.kind === "view" || mode.kind === "edit" ? mode.id : "";
  const detailQuery = useQuery(documentQueryOptions(detailId));

  const createMutation = useMutation(
    createDocumentMutationOptions(queryClient),
  );
  const updateMutation = useMutation(
    updateDocumentMutationOptions(queryClient),
  );
  const deleteMutation = useMutation(
    deleteDocumentMutationOptions(queryClient),
  );

  if (mode.kind === "create") {
    return (
      <DocumentForm
        error={error}
        pending={createMutation.isPending}
        title="New document"
        onCancel={() => {
          setError(null);
          setMode({ kind: "list" });
        }}
        onSubmit={async (values) => {
          setError(null);
          try {
            const document = await createMutation.mutateAsync(values);
            setMode({ kind: "view", id: document.id });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    );
  }

  if (mode.kind === "edit" && detailQuery.data) {
    return (
      <DocumentForm
        document={detailQuery.data}
        error={error}
        pending={updateMutation.isPending}
        title="Edit document"
        onCancel={() => {
          setError(null);
          setMode({ kind: "view", id: mode.id });
        }}
        onSubmit={async (values) => {
          setError(null);
          try {
            await updateMutation.mutateAsync({ id: mode.id, ...values });
            setMode({ kind: "view", id: mode.id });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    );
  }

  if (mode.kind === "view") {
    return (
      <DocumentDetail
        document={detailQuery.data}
        error={error}
        loading={detailQuery.isLoading}
        pendingDelete={deleteMutation.isPending}
        onBack={() => {
          setError(null);
          setMode({ kind: "list" });
        }}
        onDelete={async () => {
          if (!window.confirm("Delete this document? This cannot be undone.")) {
            return;
          }
          setError(null);
          try {
            await deleteMutation.mutateAsync(mode.id);
            setMode({ kind: "list" });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
        onEdit={() => setMode({ kind: "edit", id: mode.id })}
      />
    );
  }

  const documents = listQuery.data ?? [];

  return (
    <PageShell
      action={
        <Button size="sm" onClick={() => setMode({ kind: "create" })}>
          <IconPlus className="size-4" />
          New document
        </Button>
      }
      description="Search and manage the approved sources available to Knowledge Agent."
      title="Company knowledge"
      width="wide"
    >
      <div className="mt-8 flex items-center gap-3">
        <InputGroup className="max-w-md bg-card">
          <InputGroupInput
            aria-label="Search documents"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search documents"
            value={search}
          />
          <InputGroupAddon>
            <IconSearch />
          </InputGroupAddon>
        </InputGroup>
      </div>

      {listQuery.isLoading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading documents…</p>
      ) : null}
      {listQuery.isError ? (
        <p className="mt-8 text-sm text-destructive">
          {listQuery.error instanceof Error
            ? listQuery.error.message
            : "Could not load documents."}
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {documents.map((document) => (
          <button
            className="rounded-2xl border bg-card p-5 text-left shadow-sm transition hover:border-primary/40"
            key={document.id}
            type="button"
            onClick={() => setMode({ kind: "view", id: document.id })}
          >
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <IconBook2 className="size-5" />
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#9a742f]">
              {document.category}
            </p>
            <h2 className="mt-1 font-semibold">{document.title}</h2>
            <p className="mt-5 text-xs text-muted-foreground">
              Updated {new Date(document.updatedAt).toLocaleDateString()}
            </p>
          </button>
        ))}
      </div>

      {!listQuery.isLoading && !listQuery.isError && documents.length === 0 ? (
        <p className="mt-10 text-sm text-muted-foreground">
          {search.trim()
            ? `No documents match “${search.trim()}”.`
            : "No documents yet. Create the first one."}
        </p>
      ) : null}
    </PageShell>
  );
}

function DocumentDetail({
  document,
  loading,
  error,
  pendingDelete,
  onBack,
  onEdit,
  onDelete,
}: {
  document: KnowledgeDocument | undefined;
  loading: boolean;
  error: string | null;
  pendingDelete: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <PageShell
      action={
        document ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit
            </Button>
            <Button
              disabled={pendingDelete}
              size="sm"
              variant="destructive"
              onClick={onDelete}
            >
              {pendingDelete ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconTrash className="size-4" />
              )}
              Delete
            </Button>
          </div>
        ) : null
      }
      backButton={{ linkProps: { to: "/documents" }, label: "Documents" }}
      description={document?.category}
      title={document?.title ?? "Document"}
      width="wide"
    >
      <button
        className="mt-2 text-sm text-muted-foreground underline-offset-2 hover:underline"
        type="button"
        onClick={onBack}
      >
        Back to list
      </button>
      {loading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : null}
      {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      {document ? (
        <article className="mt-8 whitespace-pre-wrap rounded-2xl border bg-card p-6 text-sm leading-relaxed">
          {document.body}
        </article>
      ) : null}
    </PageShell>
  );
}

function DocumentForm({
  title,
  document,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  title: string;
  document?: KnowledgeDocument;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (values: {
    title: string;
    category: string;
    body: string;
  }) => Promise<void>;
}) {
  const fieldId = useId();
  const [docTitle, setDocTitle] = useState(document?.title ?? "");
  const [category, setCategory] = useState(document?.category ?? "");
  const [body, setBody] = useState(document?.body ?? "");

  useEffect(() => {
    if (!document) return;
    setDocTitle(document.title);
    setCategory(document.category);
    setBody(document.body);
  }, [document]);

  return (
    <PageShell
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={
              pending || !docTitle.trim() || !category.trim() || !body.trim()
            }
            size="sm"
            onClick={() =>
              void onSubmit({
                title: docTitle.trim(),
                category: category.trim(),
                body,
              })
            }
          >
            {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      }
      description="Title, category, and body. Agents can search and cite this text."
      title={title}
      width="wide"
    >
      <div className="mt-8 space-y-4">
        <label className="flex flex-col gap-1.5" htmlFor={`${fieldId}-title`}>
          <span className="text-sm text-muted-foreground">Title</span>
          <Input
            id={`${fieldId}-title`}
            value={docTitle}
            onChange={(event) => setDocTitle(event.target.value)}
          />
        </label>
        <label
          className="flex flex-col gap-1.5"
          htmlFor={`${fieldId}-category`}
        >
          <span className="text-sm text-muted-foreground">Category</span>
          <Input
            id={`${fieldId}-category`}
            placeholder="Engineering"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5" htmlFor={`${fieldId}-body`}>
          <span className="text-sm text-muted-foreground">Body</span>
          <Textarea
            id={`${fieldId}-body`}
            className="min-h-64"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </PageShell>
  );
}
