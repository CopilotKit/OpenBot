CREATE TABLE "revoked_access" (
	"email" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" text NOT NULL
);
