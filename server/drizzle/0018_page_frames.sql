CREATE TABLE "computer_page_frame" (
	"computer_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"frame" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_page_frame_computer_id_tool_call_id_pk" PRIMARY KEY("computer_id","tool_call_id")
);
--> statement-breakpoint
CREATE INDEX "computer_page_frame_captured_idx" ON "computer_page_frame" USING btree ("captured_at");