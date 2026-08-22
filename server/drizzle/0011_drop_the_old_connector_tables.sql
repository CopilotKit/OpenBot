-- Drops what is left of the old connector subsystem. THIS DESTROYS DATA AND CANNOT BE ROLLED BACK.
--
-- These four tables were the bookkeeping for the worker that synced documents into the local index
-- dropped in 0010: which sources were configured, where each sync had got to, which webhooks were
-- registered with the vendor, and how each run went. The code that wrote them went with the old
-- connector and the worker's sync runner, so nothing has touched them since.
--
-- What is lost is operational history rather than anybody's content: run outcomes, cursors, and the
-- `source_metadata` of each configured source. No credential goes with it. `connector_instances`
-- only ever pointed at the vault by id, and that pointer is `ON DELETE SET NULL`, so the row in
-- `credentials` is untouched and any secret it holds stays exactly where it was.
--
-- A vendor-side webhook registered by the old connector is not withdrawn by this. Nothing has been
-- listening to those deliveries since the connector was removed, and the subscription expires on
-- its own, but a deployment that wants it gone now must revoke it at the vendor.
--
-- "Connector" still means something in OpenBot. The per-person plugin connectors live in the
-- `plugins` schema, are unaffected here, and are what `/admin/plugins` configures.
--
-- Named in dependency order and dropped without CASCADE on purpose. CASCADE would also remove
-- whatever a fork had hung off these without saying what it took; this way such a deployment gets
-- a failed migration that changes nothing, since the whole file is one transaction.
DROP TABLE "connector_cursors";--> statement-breakpoint
DROP TABLE "webhook_subscriptions";--> statement-breakpoint
DROP TABLE "sync_runs";--> statement-breakpoint
DROP TABLE "connector_instances";--> statement-breakpoint
-- Both enums existed only for the columns above. `credential_kind` keeps its `connector` value:
-- that is a kind of secret, not a row in these tables, and removing a value from an enum in use is
-- a separate question from removing a table nothing reads.
DROP TYPE "public"."connector_type";--> statement-breakpoint
DROP TYPE "public"."sync_status";
