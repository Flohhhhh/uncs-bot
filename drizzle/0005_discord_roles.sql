CREATE TABLE "discord_role_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"requested_by" text,
	"trigger" text NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"role_kind" text NOT NULL,
	"role_id" text NOT NULL,
	"operation" text NOT NULL,
	"basis_type" text NOT NULL,
	"basis_id" text NOT NULL,
	"changed" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"message" text DEFAULT 'Recorded before contacting Discord.' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "supporter_members" ALTER COLUMN "campaign_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supporter_members" ALTER COLUMN "patreon_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supporter_payments" ALTER COLUMN "campaign_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "whitelist_applications" ADD COLUMN "access_intent" text DEFAULT 'grant' NOT NULL;--> statement-breakpoint
ALTER TABLE "whitelist_applications" ADD COLUMN "whitelist_grant" text;--> statement-breakpoint
ALTER TABLE "whitelist_applications" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supporter_members" ADD COLUMN "provider" text DEFAULT 'patreon' NOT NULL;--> statement-breakpoint
ALTER TABLE "supporter_members" ADD COLUMN "discord_source" text;--> statement-breakpoint
ALTER TABLE "supporter_members" ADD COLUMN "patreon_discord_id" text;--> statement-breakpoint
ALTER TABLE "supporter_members" ADD COLUMN "steam_source" text;--> statement-breakpoint
ALTER TABLE "supporter_members" ADD COLUMN "steam_application_id" uuid;--> statement-breakpoint
ALTER TABLE "supporter_payments" ADD COLUMN "minimum_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supporter_payments" ADD COLUMN "recorded_by" text;--> statement-breakpoint
CREATE INDEX "discord_role_actions_user_idx" ON "discord_role_actions" USING btree ("guild_id","discord_user_id","role_kind","created_at");--> statement-breakpoint
CREATE INDEX "discord_role_actions_created_idx" ON "discord_role_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "whitelist_applications_discord_idx" ON "whitelist_applications" USING btree ("discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_paypal_discord_unique" ON "supporter_members" USING btree ("discord_id") WHERE "supporter_members"."provider" = 'paypal';--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_paypal_steam_unique" ON "supporter_members" USING btree ("steam_id") WHERE "supporter_members"."provider" = 'paypal';--> statement-breakpoint
CREATE UNIQUE INDEX "supporter_payment_paypal_reference_unique" ON "supporter_payments" USING btree ("reference") WHERE "supporter_payments"."source" = 'paypal';--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_provider_check" CHECK ("supporter_members"."provider" in ('patreon', 'paypal'));--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_patreon_fields_check" CHECK ("supporter_members"."provider" <> 'patreon' or ("supporter_members"."campaign_id" is not null and "supporter_members"."patreon_member_id" is not null));--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_paypal_fields_check" CHECK ("supporter_members"."provider" <> 'paypal' or ("supporter_members"."campaign_id" is null and "supporter_members"."patreon_member_id" is null));--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_discord_source_check" CHECK ("supporter_members"."discord_source" is null or ("supporter_members"."discord_id" is not null and ("supporter_members"."discord_source" = 'staff' or ("supporter_members"."discord_source" = 'patreon' and "supporter_members"."provider" = 'patreon'))));--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_steam_source_check" CHECK ("supporter_members"."steam_source" is null or ("supporter_members"."steam_id" is not null and ("supporter_members"."steam_source" = 'staff' or ("supporter_members"."steam_source" = 'application' and "supporter_members"."provider" = 'patreon'))));--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_steam_application_check" CHECK (("supporter_members"."steam_application_id" is null and "supporter_members"."steam_source" is distinct from 'application') or ("supporter_members"."steam_application_id" is not null and "supporter_members"."steam_source" = 'application'));--> statement-breakpoint
ALTER TABLE "supporter_members" ADD CONSTRAINT "supporter_members_patreon_discord_check" CHECK ("supporter_members"."patreon_discord_id" is null or "supporter_members"."provider" = 'patreon');--> statement-breakpoint
ALTER TABLE "supporter_payments" ADD CONSTRAINT "supporter_payments_paypal_fields_check" CHECK ("supporter_payments"."source" <> 'paypal' or ("supporter_payments"."campaign_id" is null and "supporter_payments"."amount_cents" is not null and "supporter_payments"."currency" is not null and "supporter_payments"."verification_state" = 'verified'));