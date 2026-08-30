CREATE TABLE "bot_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"owner_user_id" text NOT NULL,
	"slug" text NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_boundaries" (
	"import_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"expression" text NOT NULL,
	"source_key" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "template_boundaries_import_id_expression_pk" PRIMARY KEY("import_id","expression")
);
--> statement-breakpoint
CREATE TABLE "template_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"digest" text NOT NULL,
	"slug" text NOT NULL,
	"template_version" text,
	"author_claim" text,
	"source" text NOT NULL,
	"source_ref" text,
	"document" jsonb NOT NULL,
	"imported_by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_requests" (
	"import_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"why" text NOT NULL,
	"status" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "template_requests_import_id_kind_ref_pk" PRIMARY KEY("import_id","kind","ref")
);
--> statement-breakpoint
ALTER TABLE "bot_templates" ADD CONSTRAINT "bot_templates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_templates" ADD CONSTRAINT "bot_templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_boundaries" ADD CONSTRAINT "template_boundaries_import_id_template_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."template_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_boundaries" ADD CONSTRAINT "template_boundaries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_imports" ADD CONSTRAINT "template_imports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_requests" ADD CONSTRAINT "template_requests_import_id_template_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."template_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_templates_owner_slug_key" ON "bot_templates" USING btree ("owner_user_id","slug");--> statement-breakpoint
CREATE INDEX "template_boundaries_agent_idx" ON "template_boundaries" USING btree ("agent_id","removed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "template_imports_agent_key" ON "template_imports" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "template_imports_digest_idx" ON "template_imports" USING btree ("digest");