CREATE TABLE "template_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"sha" text NOT NULL,
	"registered_by" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
