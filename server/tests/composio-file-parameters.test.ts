import { afterEach, describe, expect, test } from "bun:test";
import { ToolSchema } from "@composio/core";
import {
  callTool,
  listTools,
  useComposioClient,
  VERSION_ARG,
} from "../src/plugins/composio";
import {
  buildComposioClient,
  type ComposioVendor,
} from "../src/plugins/composio-adapter";
import fixture from "./fixtures/composio-file-actions.json";

/**
 * Actions whose file parameter is optional, asserted on the rows Composio actually publishes.
 *
 * THE DEFECT. The listing dropped every action carrying a `file_uploadable` parameter anywhere in
 * its schema, on the right argument (a model can only invent the staging key such a parameter asks
 * for) applied to the wrong set. On Composio's Gmail toolkit at `toolkit_versions=latest` that
 * dropped exactly GMAIL_SEND_EMAIL, GMAIL_CREATE_EMAIL_DRAFT, GMAIL_REPLY_TO_THREAD and
 * GMAIL_UPDATE_DRAFT: the only file in each is `attachment`, a single file or a list of them, and
 * none of the four requires it. A Bot with Gmail could read mail and could not send, draft or reply.
 *
 * THE ROWS ARE THE VENDOR'S, NOT A SKETCH OF THEM. `fixtures/composio-file-actions.json` holds the
 * rows `client.tools.list` answered with, verbatim but for `output_parameters`, so the attachment
 * arrives in the shape that defeated the old walk: an `anyOf` of the file object and an array of
 * it, under a property nothing requires. The fake below hands those rows over the way the vendor
 * would, through the real adapter: the listing as the raw page, and the single-tool resolve as the
 * SDK's own `transformToolCases` returns it, renamed and run through `ToolSchema.parse`
 * (`@composio/core` 0.18.1).
 */

afterEach(() => useComposioClient(null));

/** One row as the listing hands it over: the wire's own snake_case, nothing parsed. */
type WireRow = {
  slug: string;
  name: string;
  version: string;
  input_parameters: Record<string, unknown>;
  available_versions?: string[];
  deprecated?: { is_deprecated?: boolean };
  no_auth?: boolean;
  [key: string]: unknown;
};

const rows: Record<"gmail" | "googledrive", WireRow[]> = fixture;

/** A vendor method nothing in a given test should reach, which says so rather than answering. */
const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/**
 * The vendor for one app's rows, recording every execute it is asked for.
 *
 * Every row is copied on the way out, so nothing the code under test does to what it was handed
 * can reach the next request, and the expectations below can be computed from the fixture itself.
 */
function vendorFor(
  toolkit: keyof typeof rows,
  sent: unknown[] = [],
): ComposioVendor {
  const published = rows[toolkit];
  return {
    tools: {
      list: async (query) => ({
        items: query.toolkit_slug === toolkit ? structuredClone(published) : [],
        next_cursor: null,
      }),
      getRawComposioToolBySlug: async (slug, options) => {
        const row = published.find(
          (candidate) =>
            candidate.slug === slug && candidate.version === options?.version,
        );
        if (!row) throw new Error(`${slug} is not in this fixture.`);
        // What `Tools.transformToolCases` builds before the SDK hands a resolved tool back.
        return ToolSchema.parse({
          ...structuredClone(row),
          inputParameters: structuredClone(row.input_parameters),
          availableVersions: row.available_versions,
          isDeprecated: row.deprecated?.is_deprecated ?? false,
          isNoAuth: row.no_auth,
        });
      },
      execute: async (slug, body) => {
        sent.push([slug, structuredClone(body)]);
        return { data: { id: "sent_1" }, error: null, successful: true };
      },
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: refuse("authConfigs.list"),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: refuse("connectedAccounts.list"),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  };
}

/** The row this fixture publishes under one slug, whole. */
function published(toolkit: keyof typeof rows, slug: string): WireRow {
  const row = rows[toolkit].find((candidate) => candidate.slug === slug);
  if (!row) throw new Error(`${slug} is not in this fixture.`);
  return row;
}

/** A row's schema as the vendor wrote it, less one named property. */
function without(schema: Record<string, unknown>, name: string) {
  const copy = structuredClone(schema) as {
    properties: Record<string, unknown>;
  };
  delete copy.properties[name];
  return copy;
}

const GMAIL_WRITES = [
  "GMAIL_SEND_EMAIL",
  "GMAIL_CREATE_EMAIL_DRAFT",
  "GMAIL_REPLY_TO_THREAD",
  "GMAIL_UPDATE_DRAFT",
];

describe("an action whose file parameter is optional", () => {
  test("Gmail's send, draft and reply actions are offered without the attachment", async () => {
    useComposioClient(buildComposioClient(vendorFor("gmail")).actions);

    const listed = await listTools({ url: "composio://gmail" });

    // All five, where the old filter left GMAIL_FETCH_EMAILS alone.
    expect(listed.map((tool) => tool.name)).toEqual([
      ...GMAIL_WRITES,
      "GMAIL_FETCH_EMAILS",
    ]);

    for (const slug of GMAIL_WRITES) {
      const tool = listed.find((candidate) => candidate.name === slug);
      const wire = published("gmail", slug).input_parameters;
      /*
       * THE SCHEMA THE VENDOR WROTE, LESS THE ATTACHMENT AND NOTHING ELSE. Every other property,
       * the `required` list where there is one (`thread_id`, `draft_id`), every description and
       * example is still there, because a model choosing how to send an email reads all of it.
       * The slug rides in the comparison so a failure names the action.
       */
      expect({ slug, schema: tool?.inputSchema }).toEqual({
        slug,
        schema: without(wire, "attachment"),
      });
      // And no staging descriptor survives anywhere in what a model is shown.
      expect(JSON.stringify(tool?.inputSchema)).not.toContain(
        "file_uploadable",
      );
    }

    // The two whose `required` is not empty still carry it, untouched.
    const reply = listed.find((tool) => tool.name === "GMAIL_REPLY_TO_THREAD");
    expect(reply?.inputSchema.required).toEqual(["thread_id"]);
    const update = listed.find((tool) => tool.name === "GMAIL_UPDATE_DRAFT");
    expect(update?.inputSchema.required).toEqual(["draft_id"]);

    // An action with no file in it reaches a model exactly as published.
    const read = listed.find((tool) => tool.name === "GMAIL_FETCH_EMAILS");
    expect(read?.inputSchema).toEqual(
      published("gmail", "GMAIL_FETCH_EMAILS").input_parameters,
    );
  });

  test("a Drive upload that needs its file is still dropped, beside a create that only accepts one", async () => {
    /*
     * THE OTHER HALF, ON A REAL PAIR FROM ONE APP. GOOGLEDRIVE_UPLOAD_FILE requires `file_to_upload`
     * and GOOGLEDRIVE_CREATE_FILE does not, and both spell it as the same `FileUploadable` object.
     * The first has no call a model can make, so it stays out; the second makes a file from its
     * name and type alone, so it is offered without the upload.
     */
    useComposioClient(buildComposioClient(vendorFor("googledrive")).actions);

    const listed = await listTools({ url: "composio://googledrive" });

    expect(listed.map((tool) => tool.name)).toEqual([
      "GOOGLEDRIVE_CREATE_FILE",
    ]);
    expect(listed[0]?.inputSchema).toEqual(
      without(
        published("googledrive", "GOOGLEDRIVE_CREATE_FILE").input_parameters,
        "file_to_upload",
      ),
    );
  });

  test("a call that carries the attachment anyway is refused, and Composio is sent nothing", async () => {
    const sent: unknown[] = [];
    useComposioClient(buildComposioClient(vendorFor("gmail", sent)).actions);
    const connection = { url: "composio://gmail", actorId: "user_1" };
    const version = published("gmail", "GMAIL_SEND_EMAIL").version;
    const email = {
      recipient_email: "someone@example.com",
      subject: "The report",
      body: "Attached.",
    };
    /*
     * BOTH SHAPES THE VENDOR ACCEPTS, because the `anyOf` takes one file or a list of them and a
     * model that invents one will invent either. The `s3key` is the made-up value the parameter was
     * removed for: nothing in this deployment uploads to Composio's bucket.
     */
    const invented = {
      name: "report.pdf",
      mimetype: "application/pdf",
      s3key: "made/up/by/the/model",
    };

    for (const attachment of [invented, [invented]]) {
      const result = await callTool(connection, "GMAIL_SEND_EMAIL", {
        [VERSION_ARG]: version,
        ...email,
        attachment,
      });
      expect(result.isError).toBe(true);
      // The sentence names the parameter and the remedy, so the model can make the call that works.
      expect(result.text).toContain("attachment");
      expect(result.text).toMatch(/again without attachment/);
    }
    expect(sent).toEqual([]);

    /*
     * AND THE SAME EMAIL WITHOUT IT GOES OUT, which is what the refusal says to do. A `null` is how
     * Composio documents "no attachment", so it carries nothing that needs refusing and is passed on
     * as the model wrote it.
     */
    const sending = await callTool(connection, "GMAIL_SEND_EMAIL", {
      [VERSION_ARG]: version,
      ...email,
      attachment: null,
    });
    expect(sending.isError).toBe(false);
    expect(sent).toEqual([
      [
        "GMAIL_SEND_EMAIL",
        {
          arguments: { ...email, attachment: null },
          userId: "user_1",
          version,
        },
      ],
    ]);
  });
});
