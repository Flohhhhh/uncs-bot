CREATE TABLE "guild_welcome_settings" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"message" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
