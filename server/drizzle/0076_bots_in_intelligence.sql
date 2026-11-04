CREATE TABLE "intelligence_copies" (
	"name" text PRIMARY KEY NOT NULL,
	"copied" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_agents" DROP CONSTRAINT "channel_agents_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_last_message_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_preferences" DROP CONSTRAINT "agent_preferences_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "component_exclusions" DROP CONSTRAINT "component_exclusions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "app_access_requests" DROP CONSTRAINT "app_access_requests_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "plugin_grants" DROP CONSTRAINT "plugin_grants_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "responsibilities" DROP CONSTRAINT "responsibilities_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_sources" DROP CONSTRAINT "memory_sources_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "personal_memories" DROP CONSTRAINT "personal_memories_formed_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "default_opt_outs" DROP CONSTRAINT "default_opt_outs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "proactive_runs" DROP CONSTRAINT "proactive_runs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "proactive_settings" DROP CONSTRAINT "proactive_settings_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "proactive_suggestions" DROP CONSTRAINT "proactive_suggestions_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "bot_tasks" DROP CONSTRAINT "bot_tasks_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "demonstrations" DROP CONSTRAINT "demonstrations_bot_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_bindings" DROP CONSTRAINT "delivery_bindings_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_challenges" DROP CONSTRAINT "delivery_challenges_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_inbox" DROP CONSTRAINT "delivery_inbox_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_outbox" DROP CONSTRAINT "delivery_outbox_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "bot_lifecycle" DROP CONSTRAINT "bot_lifecycle_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "team_bot_assignments" DROP CONSTRAINT "team_bot_assignments_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "team_bot_audience" DROP CONSTRAINT "team_bot_audience_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "team_bot_consents" DROP CONSTRAINT "team_bot_consents_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "team_bot_publications" DROP CONSTRAINT "team_bot_publications_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_use_approvals" DROP CONSTRAINT "shared_use_approvals_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "shared_use_requests" DROP CONSTRAINT "shared_use_requests_agent_id_agents_id_fk";
