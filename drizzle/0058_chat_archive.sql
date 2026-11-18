CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "chat_archive_sources" (
	"server_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"revision" text NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"anchor" text DEFAULT '' NOT NULL,
	"started_at" bigint DEFAULT 0 NOT NULL,
	"last_read_at" timestamp with time zone,
	"state" text DEFAULT 'waiting' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"server_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text DEFAULT 'message' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"steam_id" text,
	"speaker" text NOT NULL,
	"channel" text NOT NULL,
	"faction" text NOT NULL,
	"body" text NOT NULL,
	"ping" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_archive_sources" ADD CONSTRAINT "chat_archive_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_server_id_chat_archive_sources_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."chat_archive_sources"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_archive_sources_org_idx" ON "chat_archive_sources" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_seq_idx" ON "chat_messages" USING btree ("server_id","epoch","seq","kind");--> statement-breakpoint
CREATE INDEX "chat_messages_server_time_idx" ON "chat_messages" USING btree ("server_id","at","id");--> statement-breakpoint
CREATE INDEX "chat_messages_org_time_idx" ON "chat_messages" USING btree ("org_id","at","id");--> statement-breakpoint
CREATE INDEX "chat_messages_player_time_idx" ON "chat_messages" USING btree ("org_id","steam_id","at","id");--> statement-breakpoint
CREATE INDEX "chat_messages_text_idx" ON "chat_messages" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "chat_messages_name_idx" ON "chat_messages" USING gin ("speaker" gin_trgm_ops);