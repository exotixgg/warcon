CREATE TABLE "archived_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"retired_on" date NOT NULL,
	"public_leaderboards" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archived_servers" ADD CONSTRAINT "archived_servers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archived_servers_org_idx" ON "archived_servers" USING btree ("org_id");