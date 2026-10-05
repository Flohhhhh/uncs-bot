CREATE TABLE "game_feed_event_types" (
	"server_id" text NOT NULL,
	"type" varchar(64) NOT NULL,
	"day" date NOT NULL,
	"count" bigint NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	"sample" jsonb,
	CONSTRAINT "game_feed_event_types_server_id_type_day_pk" PRIMARY KEY("server_id","type","day")
);
--> statement-breakpoint
CREATE INDEX "game_feed_event_types_day_idx" ON "game_feed_event_types" USING btree ("server_id","day");