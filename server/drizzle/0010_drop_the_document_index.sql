-- Drops the document index. THIS DESTROYS DATA AND CANNOT BE ROLLED BACK.
--
-- Every row in `documents`, `chunks` and `document_acls` goes, embeddings included. A deployment
-- that connected a source before the document connector was withdrawn has real rows here, and no
-- later migration brings them back. There is nothing to migrate them to: the replacement is not
-- another table, it is asking the vendor at the moment of the question, so there is no shape for
-- this content to move into. Take a dump first if the corpus is worth anything to you.
--
-- Nothing has read or written these since the document connector and the worker's sync
-- persistence were removed, so no running deployment loses a working feature.
--
-- Named in dependency order and dropped without CASCADE on purpose. CASCADE would also remove
-- whatever a fork had hung off these tables without saying what it took; this way such a
-- deployment gets a failed migration naming the dependency, which is the outcome it wants.
DROP TABLE "chunks";--> statement-breakpoint
DROP TABLE "document_acls";--> statement-breakpoint
DROP TABLE "documents";--> statement-breakpoint
DROP TYPE "public"."acl_effect";--> statement-breakpoint
-- `vector` existed for the `embedding` column on `chunks` and for nothing else. RESTRICT is the
-- default here and is wanted. A deployment that added a vector column of its own gets a failed
-- migration rather than losing that column quietly, and because the whole migration is one
-- transaction, a failure here leaves the three tables in place too: it is all or nothing, not a
-- half-dropped database. Postgres names the dependent column in the error, though drizzle-kit
-- does not print it, so read the server log or run the statement by hand to see which it is.
-- Such a deployment should keep the extension and drop only the three tables above.
DROP EXTENSION IF EXISTS "vector";
