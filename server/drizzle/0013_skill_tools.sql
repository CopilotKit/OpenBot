CREATE TABLE "skill_tools" (
	"skill_id" text NOT NULL,
	"ref" text NOT NULL,
	"declared_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tools_skill_id_ref_pk" PRIMARY KEY("skill_id","ref")
);
--> statement-breakpoint
ALTER TABLE "skill_tools" ADD CONSTRAINT "skill_tools_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_tools_ref_idx" ON "skill_tools" USING btree ("ref");