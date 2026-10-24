CREATE TYPE "public"."check_status" AS ENUM('open', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pos_state" AS ENUM('none', 'unknown', 'created', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_desired" AS ENUM('present', 'absent');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('pending', 'retrying', 'failed', 'synced');--> statement-breakpoint
CREATE TABLE "checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"restaurant_id" text NOT NULL,
	"items" jsonb NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"status" "check_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_rate_limit" (
	"restaurant_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_sync" (
	"check_id" uuid PRIMARY KEY NOT NULL,
	"restaurant_id" text NOT NULL,
	"desired" "sync_desired" NOT NULL,
	"pos_state" "pos_state" DEFAULT 'none' NOT NULL,
	"pos_order_id" text,
	"status" "sync_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos_sync" ADD CONSTRAINT "pos_sync_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pos_request_log_restaurant_sent_idx" ON "pos_request_log" USING btree ("restaurant_id","sent_at");--> statement-breakpoint
CREATE INDEX "pos_sync_due_idx" ON "pos_sync" USING btree ("next_attempt_at") WHERE "pos_sync"."status" in ('pending', 'retrying');