ALTER TABLE "routines" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "goal_by_title" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "routines" SET "goal_by_title" = true;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_goal_id_responsibilities_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."responsibilities"("id") ON DELETE set null ON UPDATE no action;