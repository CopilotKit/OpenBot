CREATE TABLE "computer_page_frame" (
	"computer_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"frame" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_page_frame_computer_id_url_pk" PRIMARY KEY("computer_id","url")
);
