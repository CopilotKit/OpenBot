ALTER TABLE "attachments" DROP CONSTRAINT "attachments_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_bindings" DROP CONSTRAINT "delivery_bindings_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_challenges" DROP CONSTRAINT "delivery_challenges_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_inbox" DROP CONSTRAINT "delivery_inbox_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_outbox" DROP CONSTRAINT "delivery_outbox_channel_id_channels_id_fk";
