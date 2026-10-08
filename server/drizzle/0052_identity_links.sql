CREATE TABLE "identity_link_challenges" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"realm" text NOT NULL,
	"subject" text NOT NULL,
	"handle" text,
	"confirmed_user_id" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_links" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"realm" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"handle" text,
	"verified_by" text NOT NULL,
	"credential_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_links_verified_by_check" CHECK ("identity_links"."verified_by" IN ('challenge', 'oauth')),
	CONSTRAINT "identity_links_status_check" CHECK ("identity_links"."status" IN ('active', 'needs_reconnect'))
);
--> statement-breakpoint
ALTER TABLE "identity_links" ADD CONSTRAINT "identity_links_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_link_challenges_expiry_idx" ON "identity_link_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_identity_idx" ON "identity_links" USING btree ("provider","realm","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_links_user_realm_idx" ON "identity_links" USING btree ("user_id","provider","realm");