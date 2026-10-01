CREATE TABLE "map_vote_ballots" (
	"vote_id" uuid NOT NULL,
	"discord_user_id" text NOT NULL,
	"choice" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "map_vote_ballots_vote_id_discord_user_id_pk" PRIMARY KEY("vote_id","discord_user_id")
);
--> statement-breakpoint
CREATE TABLE "map_votes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"server_name" text NOT NULL,
	"connection_hash" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"reason" text NOT NULL,
	"request_hash" text NOT NULL,
	"choices" jsonb NOT NULL,
	"revision" text NOT NULL,
	"current_map" text NOT NULL,
	"current_index" integer NOT NULL,
	"round_started_at" timestamp with time zone,
	"state" text DEFAULT 'publishing' NOT NULL,
	"winner" integer,
	"counts" jsonb NOT NULL,
	"message" text DEFAULT 'Creating the Discord ballot.' NOT NULL,
	"cancellation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_event_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"operation" jsonb NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"message" text DEFAULT 'Recorded before contacting the game.' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"server_name" text NOT NULL,
	"connection_hash" text NOT NULL,
	"guild_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"reason" text NOT NULL,
	"request_hash" text NOT NULL,
	"options" jsonb NOT NULL,
	"original_lock" boolean NOT NULL,
	"initial_revision" text NOT NULL,
	"restore_revision" text,
	"state" text DEFAULT 'preparing' NOT NULL,
	"progress" jsonb NOT NULL,
	"operation_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"message" text DEFAULT 'Preparing the optional event.' NOT NULL,
	"last_action_id" uuid,
	"stop" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whitelist_applications" DROP CONSTRAINT "whitelist_applications_discord_user_id_unique";--> statement-breakpoint
ALTER TABLE "whitelist_applications" DROP CONSTRAINT "whitelist_applications_steam_id_unique";--> statement-breakpoint
DROP INDEX "whitelist_applications_submitted_idx";--> statement-breakpoint
DROP INDEX "combat_events_received_idx";--> statement-breakpoint
DROP INDEX "combat_events_killer_received_idx";--> statement-breakpoint
DROP INDEX "combat_events_victim_received_idx";--> statement-breakpoint
ALTER TABLE "combat_events" DROP CONSTRAINT "combat_events_server_instance_id_event_id_pk";--> statement-breakpoint
ALTER TABLE "combat_events" ADD CONSTRAINT "combat_events_server_id_server_instance_id_event_id_pk" PRIMARY KEY("server_id","server_instance_id","event_id");--> statement-breakpoint
ALTER TABLE "whitelist_applications" ADD COLUMN "server_id" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "combat_events" ADD COLUMN "server_id" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "map_vote_ballots" ADD CONSTRAINT "map_vote_ballots_vote_id_map_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."map_votes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_event_operations" ADD CONSTRAINT "server_event_operations_event_id_server_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."server_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "map_votes_active_server_idx" ON "map_votes" USING btree ("server_id") WHERE "map_votes"."state" in ('publishing', 'open', 'closing', 'needs_review');--> statement-breakpoint
CREATE INDEX "map_votes_created_idx" ON "map_votes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "server_event_operations_event_idx" ON "server_event_operations" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "server_events_active_server_idx" ON "server_events" USING btree ("server_id") WHERE "server_events"."state" <> 'complete';--> statement-breakpoint
CREATE INDEX "server_events_created_idx" ON "server_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whitelist_applications_server_discord_idx" ON "whitelist_applications" USING btree ("server_id","discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whitelist_applications_server_steam_idx" ON "whitelist_applications" USING btree ("server_id","steam_id");--> statement-breakpoint
CREATE INDEX "whitelist_applications_submitted_idx" ON "whitelist_applications" USING btree ("server_id","submitted_at");--> statement-breakpoint
CREATE INDEX "combat_events_received_idx" ON "combat_events" USING btree ("server_id","received_at");--> statement-breakpoint
CREATE INDEX "combat_events_killer_received_idx" ON "combat_events" USING btree ("server_id","killer_steam_id","received_at");--> statement-breakpoint
CREATE INDEX "combat_events_victim_received_idx" ON "combat_events" USING btree ("server_id","victim_steam_id","received_at");