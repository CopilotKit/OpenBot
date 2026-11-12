CREATE TABLE "channel_projects" (
	"project_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_projects_project_id_channel_id_pk" PRIMARY KEY("project_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_projects" ADD CONSTRAINT "channel_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_projects" ADD CONSTRAINT "channel_projects_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_projects" ADD CONSTRAINT "channel_projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_projects_one_folder_per_person_idx" ON "channel_projects" USING btree ("channel_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "channel_projects_by_owner_channel_idx" ON "channel_projects" USING btree ("owner_user_id","channel_id");--> statement-breakpoint
CREATE INDEX "projects_by_owner_idx" ON "projects" USING btree ("owner_user_id","sort_order","created_at");