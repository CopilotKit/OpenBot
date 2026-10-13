CREATE TABLE "default_opt_outs" (
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"feature" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "default_opt_outs_owner_user_id_agent_id_feature_scope_pk" PRIMARY KEY("owner_user_id","agent_id","feature","scope"),
	CONSTRAINT "default_opt_outs_feature_check" CHECK ("default_opt_outs"."feature" IN ('memory_source', 'proactive_research'))
);
--> statement-breakpoint
ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "default_opt_outs" ADD CONSTRAINT "default_opt_outs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;