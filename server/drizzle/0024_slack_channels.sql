CREATE TABLE "approval_decisions" (
	"presentation_id" uuid PRIMARY KEY NOT NULL,
	"channels_thread_id" text NOT NULL,
	"conversation_key" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"action_id" text,
	"approved" boolean,
	"decided_by_user_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_thread_bindings" (
	"channels_thread_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_thread_bindings_provider_slack_check" CHECK ("external_thread_bindings"."provider" = 'slack')
);
--> statement-breakpoint
CREATE TABLE "external_thread_messages" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"channels_thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_thread_messages_role_check" CHECK ("external_thread_messages"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "external_user_links" (
	"provider" text NOT NULL,
	"provider_tenant_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"openbot_user_id" text NOT NULL,
	"provider_email" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_user_links_provider_provider_tenant_id_provider_user_id_pk" PRIMARY KEY("provider","provider_tenant_id","provider_user_id")
);
--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_messages" ADD CONSTRAINT "external_thread_messages_channels_thread_id_external_thread_bindings_channels_thread_id_fk" FOREIGN KEY ("channels_thread_id") REFERENCES "public"."external_thread_bindings"("channels_thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_user_links" ADD CONSTRAINT "external_user_links_openbot_user_id_users_id_fk" FOREIGN KEY ("openbot_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_decisions_created_at_idx" ON "approval_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_thread_bindings_provider_thread_idx" ON "external_thread_bindings" USING btree ("provider","provider_tenant_id","provider_conversation_id","provider_thread_id");--> statement-breakpoint
CREATE INDEX "external_thread_bindings_creator_thread_idx" ON "external_thread_bindings" USING btree ("created_by_user_id","channels_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_thread_messages_thread_message_idx" ON "external_thread_messages" USING btree ("channels_thread_id","message_id");--> statement-breakpoint
CREATE INDEX "external_thread_messages_thread_sequence_idx" ON "external_thread_messages" USING btree ("channels_thread_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "external_user_links_openbot_workspace_idx" ON "external_user_links" USING btree ("provider","provider_tenant_id","openbot_user_id");--> statement-breakpoint
CREATE FUNCTION "reject_external_thread_binding_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'External thread bindings are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "external_thread_bindings_append_only"
BEFORE UPDATE OR DELETE ON "external_thread_bindings"
FOR EACH ROW
EXECUTE FUNCTION "reject_external_thread_binding_mutation"();
