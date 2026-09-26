CREATE TABLE "companion_bindings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"phone_id" text NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion_pairing_codes" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"minted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "companion_pairing_codes_expires_idx" ON "companion_pairing_codes" USING btree ("expires_at");