CREATE TABLE "relay_tunnel_operations" (
	"user_id" varchar(191),
	"environment_id" varchar(191),
	"operation_id" varchar(64) NOT NULL UNIQUE,
	"hostname" text NOT NULL,
	"tunnel_name" text NOT NULL,
	"desired" jsonb NOT NULL,
	"phase" text NOT NULL,
	"resources" jsonb NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_tunnel_operations_pkey" PRIMARY KEY("user_id","environment_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_tunnel_operations_pending" ON "relay_tunnel_operations" ("updated_at") WHERE "phase" <> 'complete';