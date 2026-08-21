import { eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { documents, users } from "../db/schema";

/**
 * Answering from the company's documents, with only the ones the asker may read.
 *
 * WHY THIS EXISTS. `connectors/sync-persistence.ts` writes `documents`, `chunks` and `document_acls`
 * and nothing has ever read them back. The Knowledge coworker answers as though something were
 * behind it, so a deployment that connects a source gets rows in Postgres and no citation.
 *
 * THE ACL IS THE POINT, and it is evaluated in SQL rather than in this process. A read path that
 * fetches rows and filters them here has already fetched them: the wrong document is in memory, it is
 * one refactor from being returned, and the query cost scales with the corpus rather than with the
 * answer. The predicate below is the boundary, so the database never hands over a row the asker may
 * not read.
 *
 * DENY WINS, AND SILENCE DENIES. A document is readable when some ACL row allows one of the asker's
 * principals and no ACL row denies one. A document with no ACL rows at all is readable by nobody,
 * which is the same shape the rest of this repo uses for a grant: absence is the refusal, so a
 * document whose ACLs failed to sync is invisible rather than public.
 *
 * WHAT THIS DOES NOT DO is rank by meaning. `chunks.embedding` is `vector(1536)` and nothing in this
 * repository has ever written one: `connectors/contract.ts` has the adapter supply embeddings and no
 * adapter exists yet, and there is no embedding model in the tenant package or the environment. So
 * matching here is PostgreSQL's own full-text search over `chunks.content`, which needs no
 * configuration that a deployment does not already have. When an adapter starts writing embeddings,
 * the ranking changes behind this signature and the ACL predicate does not move.
 */

/**
 * Who is asking, as principals rather than as a user row.
 *
 * `groups` is accepted and matched, and is empty in every deployment today: `users.groups` is written
 * by nothing (see #82 and #92, which established that both halves of the group control are missing).
 * Matching it anyway means a `group:` ACL starts working the day groups arrive from an identity
 * provider instead of needing to be found and changed. Until then such a row matches nobody, which
 * denies rather than permits.
 */
export type KnowledgeAsker = {
  userId: string;
  groups: readonly string[];
};

export type KnowledgeCitation = {
  documentId: string;
  title: string;
  /** Where a person opens the document. Stored by the connector, never built here. */
  url: string;
  /** The matching passage, marked up by PostgreSQL around the terms that matched. */
  snippet: string;
};

export type KnowledgeSearch = {
  search: (input: {
    asker: KnowledgeAsker;
    query: string;
    limit?: number;
  }) => Promise<KnowledgeCitation[]>;
  /**
   * Whether there is anything to search at all.
   *
   * Asked so a deployment that has connected nothing does not offer its Bots a tool that can only
   * answer "nothing found". A tool in the list is a sentence in the prompt and a call the model may
   * spend a step on.
   *
   * Asked per run rather than at boot, for the reason plugins/tools.ts gives about grants: a source
   * connected this morning should work this afternoon, not after a restart.
   */
  anyDocuments: () => Promise<boolean>;
};

/** Enough to answer from, few enough to fit a reply. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/**
 * The text search configuration.
 *
 * Named rather than left to `default_text_search_config`, which is a server setting a deployment may
 * have changed: the same query would then stem differently on two databases and neither would say so.
 *
 * Cast to `regconfig` at every use below. Passed as a bound parameter it arrives typed as text, and
 * there is no `to_tsvector(text, text)` for PostgreSQL to resolve to — only the one-argument form and
 * `to_tsvector(regconfig, text)` — so without the cast the query fails to plan rather than falling
 * back to anything.
 */
const TEXT_CONFIG = "english";

/**
 * How the asker's identity becomes the strings an ACL row is written against.
 *
 * One shape, in one place, because a mismatch between what is written and what is matched is a
 * silent read failure rather than an error.
 */
export function principalsFor(asker: KnowledgeAsker): string[] {
  return [
    `user:${asker.userId}`,
    ...asker.groups.map((group) => `group:${group}`),
  ];
}

function boundedLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}

/**
 * The asker, with the groups the deployment holds for them.
 *
 * A separate read rather than something carried on the request, because the actor a run is for is
 * identified by id and nothing downstream of that has ever needed more. `users.groups` is `[]` for
 * everybody today; see the note on {@link KnowledgeAsker}.
 */
export async function askerFor(
  database: Database,
  userId: string,
): Promise<KnowledgeAsker> {
  const [row] = await database
    .select({ groups: users.groups })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { userId, groups: row?.groups ?? [] };
}

export function createKnowledgeSearch(database: Database): KnowledgeSearch {
  return {
    async anyDocuments() {
      const [row] = await database
        .select({ id: documents.id })
        .from(documents)
        .where(isNull(documents.deletedAt))
        .limit(1);
      return row !== undefined;
    },

    async search({ asker, query, limit }) {
      const terms = query.trim();
      /*
       * Answered here rather than by the database. `websearch_to_tsquery` turns an empty string into
       * an empty query, which matches nothing, so the result would be the same — but a Bot calling
       * this with no arguments should not become a query against every chunk in the deployment.
       */
      if (terms === "") return [];

      /*
       * One bound parameter per principal.
       *
       * Handing the driver a single JSON array and casting it to `jsonb` read better and was wrong:
       * the value arrives already encoded, so `$1::jsonb` was a JSON *string* rather than an array and
       * `jsonb_array_elements_text` refused it with "cannot extract elements from a scalar". A list of
       * parameters has no encoding to get wrong, and the list is never empty because
       * {@link principalsFor} always yields the asker's own `user:` principal.
       */
      const principals = sql.join(
        principalsFor(asker).map((principal) => sql`${principal}`),
        sql`, `,
      );

      /*
       * One row per document, not one per chunk. A long document matching in six places is one
       * citation, and returning it six times would spend the answer's whole budget on it.
       * `row_number` picks the best-ranked chunk per document, tie-broken by position so the same
       * corpus and the same question give the same passage twice running.
       */
      const rows = await database.execute<{
        document_id: string;
        title: string;
        canonical_url: string;
        snippet: string;
      }>(
        sql`
          with asked as (
            select websearch_to_tsquery(${TEXT_CONFIG}::regconfig, ${terms}) as tsq
          ),
          matched as (
            select d.id as document_id,
                   d.title as title,
                   d.canonical_url as canonical_url,
                   ts_rank(to_tsvector(${TEXT_CONFIG}::regconfig, c.content), asked.tsq) as rank,
                   ts_headline(
                     ${TEXT_CONFIG}::regconfig,
                     c.content,
                     asked.tsq,
                     'MaxFragments=1, MaxWords=40, MinWords=12'
                   ) as snippet,
                   row_number() over (
                     partition by d.id
                     order by ts_rank(
                                to_tsvector(${TEXT_CONFIG}::regconfig, c.content),
                                asked.tsq
                              ) desc,
                              c.position asc
                   ) as best
            from chunks c
            join documents d on d.id = c.document_id
            cross join asked
            where d.deleted_at is null
              and to_tsvector(${TEXT_CONFIG}::regconfig, c.content) @@ asked.tsq
              and exists (
                select 1 from document_acls a
                where a.document_id = d.id
                  and a.effect = 'allow'
                  and a.principal in (${principals})
              )
              and not exists (
                select 1 from document_acls a
                where a.document_id = d.id
                  and a.effect = 'deny'
                  and a.principal in (${principals})
              )
          )
          select document_id, title, canonical_url, snippet
          from matched
          where best = 1
          order by rank desc, title asc
          limit ${boundedLimit(limit)}
        `,
      );

      return [...rows].map((row) => ({
        documentId: row.document_id,
        title: row.title,
        url: row.canonical_url,
        snippet: row.snippet,
      }));
    },
  };
}
