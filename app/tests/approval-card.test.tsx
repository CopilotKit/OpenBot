import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard } from "@/components/gallery/decisions";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("a malformed ERP reference cannot trap an unrelated approval", async () => {
  const answers: unknown[] = [];
  const view = render(
    <ApprovalCard
      agentId="recolector-documentos"
      args={
        {
          title: "Reenviar 5 PDFs a Jefe ERP",
          summary: "Pide permiso para reenviar los documentos entre Bots.",
          approveLabel: "Reenviar los 5 PDFs",
          rejectLabel: "No reenviar",
          workspaceTransfer: {
            attachmentId: "workspaceTransfer",
            transferId: "missing",
          },
        } as never
      }
      respond={async (answer) => {
        answers.push(answer);
      }}
      result={undefined}
      status="executing"
    />,
  );

  expect(
    await view.findByText(
      "The invalid ERP transfer reference was ignored. This approval will not upload a file.",
    ),
  ).toBeTruthy();
  const approve = view.getByRole("button", {
    name: "Reenviar los 5 PDFs",
  }) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);

  await userEvent.click(approve);
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(answers).toEqual([
    {
      decision: "approved",
      transfer: {
        status: "NOT_ATTEMPTED",
        reason:
          "Invalid ERP transfer reference; no file was uploaded by this approval.",
      },
    },
  ]);
});
