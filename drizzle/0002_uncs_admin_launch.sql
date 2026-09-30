CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"request_hash" text NOT NULL,
	"details" jsonb NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"message" text DEFAULT 'Action started; result not yet recorded.' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"csrf" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whitelist_application_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "whitelist_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_display_name" text NOT NULL,
	"steam_id" text NOT NULL,
	"relationship" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"steam_ownership_verified" boolean DEFAULT false NOT NULL,
	"contact_consent" boolean NOT NULL,
	"consent_version" text NOT NULL,
	"contact_consent_at" timestamp with time zone,
	"rules_accepted_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"review_reason" text,
	"action_id" uuid,
	"review_id" uuid,
	"review_kind" text,
	"last_action_state" text,
	"last_action_message" text,
	CONSTRAINT "whitelist_applications_discord_user_id_unique" UNIQUE("discord_user_id"),
	CONSTRAINT "whitelist_applications_steam_id_unique" UNIQUE("steam_id"),
	CONSTRAINT "whitelist_applications_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "whitelist_applications_review_id_unique" UNIQUE("review_id")
);
--> statement-breakpoint
CREATE TABLE "combat_events" (
	"server_instance_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"server_name" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"event_time" double precision NOT NULL,
	"match_id" uuid,
	"map_name" text,
	"killer_steam_id" text,
	"killer_name" text,
	"victim_steam_id" text,
	"victim_name" text,
	"cause" text,
	"distance_centimeters" double precision,
	"context_tags" jsonb NOT NULL,
	"headshot" boolean NOT NULL,
	"suicide" boolean NOT NULL,
	CONSTRAINT "combat_events_server_instance_id_event_id_pk" PRIMARY KEY("server_instance_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "combat_tracking" (
	"id" text PRIMARY KEY NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	"last_cleanup_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supporter_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"fingerprint" text NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supporter_founders" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"awarded_at" timestamp with time zone NOT NULL,
	"awarded_by" text NOT NULL,
	"reason" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supporter_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"patreon_member_id" text NOT NULL,
	"display_name" text,
	"patron_status" text,
	"last_charge_status" text,
	"last_charge_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"review_state" text DEFAULT 'pending' NOT NULL,
	"discord_id" text,
	"steam_id" text,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supporter_observations" (
	"hash" text PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"patron_status" text,
	"last_charge_status" text,
	"last_charge_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supporter_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"campaign_id" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"amount_cents" integer,
	"currency" text,
	"source" text NOT NULL,
	"reference" text NOT NULL,
	"verification_state" text NOT NULL,
	"first_successful_payment_verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whitelist_application_reviews" ADD CONSTRAINT "whitelist_application_reviews_application_id_whitelist_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."whitelist_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporter_actions" ADD CONSTRAINT "supporter_actions_member_id_supporter_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."supporter_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporter_founders" ADD CONSTRAINT "supporter_founders_member_id_supporter_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."supporter_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporter_founders" ADD CONSTRAINT "supporter_founders_payment_id_supporter_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supporter_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporter_observations" ADD CONSTRAINT "supporter_observations_member_id_supporter_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."supporter_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporter_payments" ADD CONSTRAINT "supporter_payments_member_id_supporter_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."supporter_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_actions_created_idx" ON "admin_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_expiry_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "whitelist_application_reviews_application_idx" ON "whitelist_application_reviews" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "whitelist_applications_submitted_idx" ON "whitelist_applications" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "combat_events_received_idx" ON "combat_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "combat_events_killer_received_idx" ON "combat_events" USING btree ("killer_steam_id","received_at");--> statement-breakpoint
CREATE INDEX "combat_events_victim_received_idx" ON "combat_events" USING btree ("victim_steam_id","received_at");--> statement-breakpoint
CREATE INDEX "supporter_actions_member_idx" ON "supporter_actions" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_provider_member_unique" ON "supporter_members" USING btree ("campaign_id","patreon_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_discord_unique" ON "supporter_members" USING btree ("campaign_id","discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_steam_unique" ON "supporter_members" USING btree ("campaign_id","steam_id");--> statement-breakpoint
CREATE INDEX "supporter_observations_member_idx" ON "supporter_observations" USING btree ("member_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_payment_reference_unique" ON "supporter_payments" USING btree ("campaign_id","source","reference");--> statement-breakpoint
CREATE INDEX "supporter_payment_member_idx" ON "supporter_payments" USING btree ("member_id","paid_at");