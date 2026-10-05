CREATE TABLE "voice_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"anchor_message_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer NOT NULL,
	"transcript" jsonb NOT NULL,
	"summary" text,
	"summary_status" text DEFAULT 'failed' NOT NULL,
	CONSTRAINT "voice_sessions_duration_check" CHECK ("voice_sessions"."duration_seconds" >= 0),
	CONSTRAINT "voice_sessions_summary_check" CHECK (("voice_sessions"."summary_status" = 'ready' AND "voice_sessions"."summary" IS NOT NULL) OR ("voice_sessions"."summary_status" = 'failed' AND "voice_sessions"."summary" IS NULL))
);

--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "voice_sessions_channel_started_idx" ON "voice_sessions" USING btree ("channel_id","started_at","id");
