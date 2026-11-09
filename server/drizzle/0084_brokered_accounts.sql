CREATE TABLE "brokered_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"app" text NOT NULL,
	"user_id" text NOT NULL,
	"vendor_user_id" text NOT NULL,
	"account_id" text DEFAULT '' NOT NULL,
	"identity" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brokered_accounts_provider_check" CHECK ("brokered_accounts"."provider" IN ('composio', 'arcade'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_accounts_account_idx" ON "brokered_accounts" USING btree ("provider","app","user_id","vendor_user_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brokered_accounts_default_idx" ON "brokered_accounts" USING btree ("provider","app","user_id") WHERE "brokered_accounts"."is_default";--> statement-breakpoint
CREATE INDEX "brokered_accounts_user_idx" ON "brokered_accounts" USING btree ("user_id");