CREATE TABLE "learning_skill_approvals" (
	"user_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"approved_by" text NOT NULL,
	"sharing" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_skill_approvals_user_id_skill_name_pk" PRIMARY KEY("user_id","skill_name"),
	CONSTRAINT "learning_skill_approvals_approved_by_check" CHECK ("learning_skill_approvals"."approved_by" IN ('person', 'admin')),
	CONSTRAINT "learning_skill_approvals_sharing_check" CHECK ("learning_skill_approvals"."sharing" IN ('none', 'requested', 'approved', 'declined'))
);
--> statement-breakpoint
ALTER TABLE "learning_skill_approvals" ADD CONSTRAINT "learning_skill_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;