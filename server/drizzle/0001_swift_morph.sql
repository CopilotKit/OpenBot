ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "callback_token_issued_at" timestamp with time zone;