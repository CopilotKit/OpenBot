CREATE TABLE "recorder_connect_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"via" text NOT NULL,
	"organization_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recorder_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"via" text NOT NULL,
	"extension_id" text NOT NULL,
	"install_id" text NOT NULL,
	"organization_session" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "recorder_connections_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "recorder_trajectory_bindings" (
	"trajectory_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recorder_connect_codes" ADD CONSTRAINT "recorder_connect_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_connections" ADD CONSTRAINT "recorder_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_trajectory_bindings" ADD CONSTRAINT "recorder_trajectory_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recorder_trajectory_bindings" ADD CONSTRAINT "recorder_trajectory_bindings_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recorder_connect_codes_user_idx" ON "recorder_connect_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recorder_connections_user_idx" ON "recorder_connections" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recorder_connections_live_install_idx" ON "recorder_connections" USING btree ("user_id","install_id") WHERE "recorder_connections"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "recorder_trajectory_bindings_user_idx" ON "recorder_trajectory_bindings" USING btree ("user_id");