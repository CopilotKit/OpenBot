CREATE TABLE "brokered_identities" (
	"provider" text NOT NULL,
	"user_id" text NOT NULL,
	"vendor_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brokered_identities_provider_user_id_pk" PRIMARY KEY("provider","user_id"),
	CONSTRAINT "brokered_identities_provider_check" CHECK ("brokered_identities"."provider" IN ('composio', 'arcade'))
);
