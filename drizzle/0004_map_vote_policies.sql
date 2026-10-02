CREATE TABLE "map_vote_policies" (
	"server_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"policy" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"connection_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_votes" ADD COLUMN "automation" jsonb;