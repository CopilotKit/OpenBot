ALTER TABLE "bot_tasks" DROP CONSTRAINT "bot_tasks_origin_check";--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD COLUMN "client_id" text;--> statement-breakpoint
CREATE INDEX "work_items_owner_task_idx" ON "work_items" USING btree ("kind",("payload"->>'ownerUserId'),("payload"->>'taskId'));--> statement-breakpoint
CREATE UNIQUE INDEX "bot_tasks_owner_client_idx" ON "bot_tasks" USING btree ("owner_user_id","client_id");--> statement-breakpoint
ALTER TABLE "bot_tasks" ADD CONSTRAINT "bot_tasks_origin_check" CHECK ("bot_tasks"."origin" IN ('check_in', 'asked'));