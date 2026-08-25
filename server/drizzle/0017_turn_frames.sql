CREATE TABLE "computer_turn_frame" (
	"tool_call_id" text PRIMARY KEY NOT NULL,
	"computer_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"frame" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
