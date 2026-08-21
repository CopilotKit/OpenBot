ALTER TABLE "sso_providers" DROP CONSTRAINT "sso_providers_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;