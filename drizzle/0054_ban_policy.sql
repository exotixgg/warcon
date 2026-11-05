CREATE TABLE "org_ban_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_ban_policies" ADD CONSTRAINT "org_ban_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "ban_cases" (
	"entry_id" text PRIMARY KEY NOT NULL,
	"record" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ban_cases" ADD CONSTRAINT "ban_cases_entry_id_list_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."list_entries"("id") ON DELETE cascade ON UPDATE no action;
