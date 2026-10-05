CREATE TABLE "routine_sweeps" (
	"id" text PRIMARY KEY NOT NULL,
	"swept_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner" text
);
