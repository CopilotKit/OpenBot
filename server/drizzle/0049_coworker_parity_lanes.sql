CREATE TABLE "responsibility_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"responsibility_id" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"credential_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_team_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"tool_ref" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"behaviour" text NOT NULL,
	"created_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_team_rules_behaviour_check" CHECK ("approval_team_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'))
);
--> statement-breakpoint
CREATE TABLE "approval_team_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enforce_auto_review" boolean DEFAULT false NOT NULL,
	"custom_rules_enabled" boolean DEFAULT true NOT NULL,
	"host_commands_cap" text DEFAULT 'allow' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_team_settings_host_commands_cap_check" CHECK ("approval_team_settings"."host_commands_cap" IN ('ask', 'allow', 'never'))
);
--> statement-breakpoint
CREATE TABLE "proactive_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"focus" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 240 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_settings_interval_check" CHECK ("proactive_settings"."interval_minutes" >= 60 AND "proactive_settings"."interval_minutes" <= 1440),
	CONSTRAINT "proactive_settings_status_check" CHECK ("proactive_settings"."last_status" IN ('idle', 'running', 'succeeded', 'error'))
);
--> statement-breakpoint
CREATE TABLE "proactive_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"setting_id" text NOT NULL,
	"run_id" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"source_app" text,
	"source_ref" text,
	"source_link" text,
	"status" text DEFAULT 'open' NOT NULL,
	"delivered_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_suggestions_status_check" CHECK ("proactive_suggestions"."status" IN ('open', 'dismissed', 'started'))
);
--> statement-breakpoint
CREATE TABLE "action_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface" text NOT NULL,
	"bot_id" text,
	"actor_user_id" text,
	"tool_name" text NOT NULL,
	"command" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_records_surface_check" CHECK ("action_records"."surface" IN ('cloud', 'local'))
);
--> statement-breakpoint
CREATE TABLE "capability_settings" (
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"capability" text NOT NULL,
	"allowed" boolean NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_settings_scope_kind_scope_id_capability_pk" PRIMARY KEY("scope_kind","scope_id","capability"),
	CONSTRAINT "capability_settings_scope_kind_check" CHECK ("capability_settings"."scope_kind" IN ('organization', 'role', 'group'))
);
--> statement-breakpoint
CREATE TABLE "enterprise_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"model" text NOT NULL,
	"source" text NOT NULL,
	"allowed" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_usage_source_check" CHECK ("model_usage"."source" IN ('configured', 'observed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "network_policies" (
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"mode" text NOT NULL,
	"rules" jsonb DEFAULT '{"entries":[]}'::jsonb NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_policies_scope_kind_scope_id_pk" PRIMARY KEY("scope_kind","scope_id"),
	CONSTRAINT "network_policies_scope_kind_check" CHECK ("network_policies"."scope_kind" IN ('organization', 'group')),
	CONSTRAINT "network_policies_mode_check" CHECK ("network_policies"."mode" IN ('allow_all', 'defaults_plus_allowlist', 'allowlist_only'))
);
--> statement-breakpoint
CREATE TABLE "scim_connection_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"decommission_status" text DEFAULT 'active' NOT NULL,
	"decommission_cursor_user_id" text,
	"decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
	"decommission_batch_count" integer DEFAULT 0 NOT NULL,
	"decommission_revision" integer DEFAULT 0 NOT NULL,
	"decommission_completed_at" timestamp with time zone,
	"decommission_lease_id" text,
	"decommission_lease_expires_at" timestamp with time zone,
	CONSTRAINT "scim_connection_bindings_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group_members" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"membership_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_members_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_groups_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_groups_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_groups_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "scim_identity_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"user_id" text NOT NULL,
	"profile" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_identity_tombstones_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE "scim_projection_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_value" text,
	"role" text NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_projection_grants_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE "scim_subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_subjects_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_user_key" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	"email_value_index" text NOT NULL,
	"display_name" text NOT NULL,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"serialized_emails" text NOT NULL,
	"serialized_attributes" text,
	"external_id" text,
	"external_id_key" text,
	"active" boolean NOT NULL,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_users_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_users_user_name_key_unique" UNIQUE("user_name_key"),
	CONSTRAINT "scim_users_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_users_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "bot_lifecycle" (
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"paused_at" timestamp with time zone,
	"notify" text DEFAULT 'all' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_lifecycle_owner_user_id_agent_id_pk" PRIMARY KEY("owner_user_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "update_routing_preferences" (
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_routing_preferences_owner_user_id_kind_pk" PRIMARY KEY("owner_user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "saved_logins" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"origin" text NOT NULL,
	"username" text NOT NULL,
	"encrypted_password" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sign_in_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"origin" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"outcome" text,
	"thread_id" text,
	"tool_call_id" text,
	"control_request_id" text,
	"continuation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "sign_in_requests_status_check" CHECK ("sign_in_requests"."status" IN ('pending', 'filling', 'taken_over', 'signed_in', 'failed', 'cancelled', 'expired')),
	CONSTRAINT "sign_in_requests_method_check" CHECK ("sign_in_requests"."method" IS NULL OR "sign_in_requests"."method" IN ('typed', 'saved', 'takeover'))
);
--> statement-breakpoint
CREATE TABLE "team_bot_assignments" (
	"agent_id" text NOT NULL,
	"group_name" text NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_assignments_agent_id_group_name_pk" PRIMARY KEY("agent_id","group_name")
);
--> statement-breakpoint
CREATE TABLE "team_bot_audience" (
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_audience_agent_id_kind_value_pk" PRIMARY KEY("agent_id","kind","value"),
	CONSTRAINT "team_bot_audience_kind_check" CHECK ("team_bot_audience"."kind" IN ('user', 'group'))
);
--> statement-breakpoint
CREATE TABLE "team_bot_consent_defaults" (
	"user_id" text NOT NULL,
	"server_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_consent_defaults_user_id_server_id_pk" PRIMARY KEY("user_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "team_bot_consents" (
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"server_id" text NOT NULL,
	"decision" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_consents_user_id_agent_id_server_id_pk" PRIMARY KEY("user_id","agent_id","server_id"),
	CONSTRAINT "team_bot_consents_decision_check" CHECK ("team_bot_consents"."decision" IN ('always', 'once'))
);
--> statement-breakpoint
CREATE TABLE "team_bot_publications" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"published_by" text NOT NULL,
	"audience" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_bot_publications_audience_check" CHECK ("team_bot_publications"."audience" IN ('team', 'people'))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT "approval_decision_check";--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "source" text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_preferences" ADD COLUMN "auto_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_preferences" ADD COLUMN "host_commands" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_rules" ADD COLUMN "behaviour" text DEFAULT 'allow' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "formed_by" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "formed_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "source_app" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "source_link" text;--> statement-breakpoint
ALTER TABLE "personal_memories" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_bindings" ADD COLUMN "opted_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_triggers" ADD CONSTRAINT "responsibility_triggers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_team_rules" ADD CONSTRAINT "approval_team_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_team_settings" ADD CONSTRAINT "approval_team_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_settings" ADD CONSTRAINT "proactive_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_suggestions" ADD CONSTRAINT "proactive_suggestions_setting_id_proactive_settings_id_fk" FOREIGN KEY ("setting_id") REFERENCES "public"."proactive_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_scim_user_id_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_identity_tombstones" ADD CONSTRAINT "scim_identity_tombstones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_scim_user_id_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grants" ADD CONSTRAINT "scim_projection_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_subjects" ADD CONSTRAINT "scim_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_lifecycle" ADD CONSTRAINT "bot_lifecycle_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_lifecycle" ADD CONSTRAINT "bot_lifecycle_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_routing_preferences" ADD CONSTRAINT "update_routing_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_logins" ADD CONSTRAINT "saved_logins_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_requests" ADD CONSTRAINT "sign_in_requests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_assignments" ADD CONSTRAINT "team_bot_assignments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_assignments" ADD CONSTRAINT "team_bot_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_audience" ADD CONSTRAINT "team_bot_audience_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_consent_defaults" ADD CONSTRAINT "team_bot_consent_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_consents" ADD CONSTRAINT "team_bot_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_consents" ADD CONSTRAINT "team_bot_consents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_publications" ADD CONSTRAINT "team_bot_publications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_bot_publications" ADD CONSTRAINT "team_bot_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibility_triggers_owner_idx" ON "responsibility_triggers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "responsibility_triggers_responsibility_idx" ON "responsibility_triggers" USING btree ("responsibility_id");--> statement-breakpoint
CREATE INDEX "responsibility_triggers_kind_idx" ON "responsibility_triggers" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "proactive_settings_owner_agent_idx" ON "proactive_settings" USING btree ("owner_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "proactive_settings_due_idx" ON "proactive_settings" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "proactive_suggestions_owner_idx" ON "proactive_suggestions" USING btree ("owner_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "proactive_suggestions_run_idx" ON "proactive_suggestions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "action_records_created_idx" ON "action_records" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "action_records_bot_idx" ON "action_records" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_created_idx" ON "model_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "model_usage_model_idx" ON "model_usage" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "scim_connection_bindings_connection_idx" ON "scim_connection_bindings" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_connection_idx" ON "scim_group_members" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_group_idx" ON "scim_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scim_group_members_scim_user_idx" ON "scim_group_members" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_groups_connection_idx" ON "scim_groups" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_groups_domain_idx" ON "scim_groups" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstones_connection_idx" ON "scim_identity_tombstones" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstones_domain_idx" ON "scim_identity_tombstones" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstones_user_idx" ON "scim_identity_tombstones" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_connection_idx" ON "scim_projection_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_domain_idx" ON "scim_projection_grants" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_scim_user_idx" ON "scim_projection_grants" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grants_user_idx" ON "scim_projection_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_subjects_profile_source_idx" ON "scim_subjects" USING btree ("profile_source_id");--> statement-breakpoint
CREATE INDEX "scim_users_connection_idx" ON "scim_users" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_users_domain_idx" ON "scim_users" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_users_user_idx" ON "scim_users" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_logins_owner_origin_username_idx" ON "saved_logins" USING btree ("owner_user_id","origin","username");--> statement-breakpoint
CREATE INDEX "saved_logins_owner_idx" ON "saved_logins" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "sign_in_requests_owner_idx" ON "sign_in_requests" USING btree ("owner_user_id","status");--> statement-breakpoint
ALTER TABLE "personal_memories" ADD CONSTRAINT "personal_memories_formed_by_agent_id_agents_id_fk" FOREIGN KEY ("formed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_memories_formed_idx" ON "personal_memories" USING btree ("owner_user_id","formed_by_agent_id");--> statement-breakpoint
ALTER TABLE "approval_preferences" ADD CONSTRAINT "approval_preferences_host_commands_check" CHECK ("approval_preferences"."host_commands" IN ('ask', 'allow', 'never'));--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_decision_check" CHECK ("approval_requests"."decision" IN ('allow_once', 'allow_always', 'deny', 'handled'));--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_behaviour_check" CHECK ("approval_rules"."behaviour" IN ('allow', 'pre_approved', 'ask', 'hand_off'));