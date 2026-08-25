CREATE TABLE "work_items" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE INDEX "work_items_claimable_idx" ON "work_items" USING btree ("kind","run_at");