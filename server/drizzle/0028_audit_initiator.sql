ALTER TABLE "audit_events" ADD COLUMN "initiator_kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "initiator_id" text;--> statement-breakpoint
CREATE INDEX "audit_events_initiator_time_idx" ON "audit_events" USING btree ("initiator_kind","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);