CREATE TABLE "relay_auth_sessions" (
	"session_id" varchar(64) PRIMARY KEY,
	"user_id" varchar(191) NOT NULL,
	"client_id" varchar(32) NOT NULL,
	"thumbprint" varchar(128) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"label" text,
	"last_used_at" varchar(64) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_email_sign_in_codes" (
	"code_id" varchar(64) PRIMARY KEY,
	"email" varchar(320) NOT NULL,
	"thumbprint" varchar(128) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" varchar(64),
	"expires_at" varchar(64) NOT NULL,
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_users" (
	"user_id" varchar(191) PRIMARY KEY,
	"email" varchar(320),
	"last_sign_in_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_mobile_devices" ADD COLUMN "session_id" varchar(64);--> statement-breakpoint
CREATE INDEX "idx_relay_auth_sessions_user" ON "relay_auth_sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_relay_auth_sessions_expires_at" ON "relay_auth_sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_relay_email_sign_in_codes_email" ON "relay_email_sign_in_codes" ("email","created_at");--> statement-breakpoint
CREATE INDEX "idx_relay_email_sign_in_codes_expires_at" ON "relay_email_sign_in_codes" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_relay_mobile_devices_session_id" ON "relay_mobile_devices" ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_users_email" ON "relay_users" ("email");