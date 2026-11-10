CREATE TABLE "approval_conversation_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"account" text,
	"kind" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_decision_check";--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "approval_team_settings" ADD COLUMN "action_kinds" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_conversation_grants" ADD CONSTRAINT "approval_conversation_grants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_conversation_grants" ADD CONSTRAINT "approval_conversation_grants_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_conversation_grants_thread_idx" ON "approval_conversation_grants" USING btree ("owner_user_id","thread_id");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_decision_check" CHECK ("approval_requests"."decision" IN ('allow_once', 'allow_conversation', 'allow_always', 'deny', 'handled'));