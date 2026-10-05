CREATE TABLE "learning_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_thread_bindings" (
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"container_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_thread_bindings_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
