CREATE TABLE "computer_snapshot" (
	"computer_id" text PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"url" text NOT NULL,
	"elements" jsonb NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
