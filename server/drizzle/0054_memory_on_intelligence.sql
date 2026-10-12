ALTER TABLE "personal_memories" ADD COLUMN "intelligence_memory_id" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "intelligence_digest" text;--> statement-breakpoint
CREATE INDEX "personal_memories_intelligence_idx" ON "personal_memories" USING btree ("owner_user_id","intelligence_memory_id");