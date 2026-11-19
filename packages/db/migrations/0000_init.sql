CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"permissions" text DEFAULT 'full' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"duration" real,
	"aspect_ratio" text,
	"max_width" integer,
	"max_height" integer,
	"max_frame_rate" real,
	"resolution_tier" text,
	"max_resolution_tier" text DEFAULT '1080p' NOT NULL,
	"video_quality" text DEFAULT 'plus' NOT NULL,
	"mp4_support" text DEFAULT 'none' NOT NULL,
	"normalize_audio" boolean DEFAULT false NOT NULL,
	"protection" text DEFAULT 'none' NOT NULL,
	"passthrough" text,
	"title" text,
	"upload_id" text,
	"live_stream_id" text,
	"is_live" boolean DEFAULT false NOT NULL,
	"source_key" text,
	"source_meta" jsonb,
	"input" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"renditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"static_renditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_storyboard" boolean DEFAULT false NOT NULL,
	"has_dash" boolean DEFAULT false NOT NULL,
	"errors" jsonb,
	"ai" jsonb,
	"progress" jsonb,
	"test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drm_configs" (
	"environment_id" text PRIMARY KEY NOT NULL,
	"settings_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drm_keys" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"key_enc" text NOT NULL,
	"iv_hex" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'development' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_segments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"live_stream_id" text NOT NULL,
	"session_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"stream_key" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"latency_mode" text DEFAULT 'low' NOT NULL,
	"reconnect_window" integer DEFAULT 60 NOT NULL,
	"recording" boolean DEFAULT true NOT NULL,
	"new_asset_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_asset_id" text,
	"active_session_id" text,
	"recent_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passthrough" text,
	"title" text,
	"health" jsonb,
	"last_active_at" timestamp with time zone,
	"last_disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_streams_stream_key_unique" UNIQUE("stream_key")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_ids" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"asset_id" text,
	"live_stream_id" text,
	"policy" text DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"public_key" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulcast_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"live_stream_id" text NOT NULL,
	"url" text NOT NULL,
	"stream_key" text,
	"passthrough" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"type" text NOT NULL,
	"text_type" text,
	"text_source" text,
	"language_code" text,
	"name" text,
	"closed_captions" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"storage_key" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"cors_origin" text,
	"new_asset_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"asset_id" text,
	"storage_key" text NOT NULL,
	"timeout_seconds" integer DEFAULT 3600 NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"environment_id" text NOT NULL,
	"day" text NOT NULL,
	"encoded_seconds" real DEFAULT 0 NOT NULL,
	"stored_seconds" real DEFAULT 0 NOT NULL,
	"delivered_seconds" real DEFAULT 0 NOT NULL,
	"live_seconds" real DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_environment_id_day_pk" PRIMARY KEY("environment_id","day")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "views" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"playback_id" text NOT NULL,
	"asset_id" text,
	"live_stream_id" text,
	"viewer_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"watch_time_ms" integer DEFAULT 0 NOT NULL,
	"startup_ms" integer,
	"rebuffer_count" integer DEFAULT 0 NOT NULL,
	"rebuffer_ms" integer DEFAULT 0 NOT NULL,
	"seek_count" integer DEFAULT 0 NOT NULL,
	"max_height" integer,
	"error_code" text,
	"error_message" text,
	"exited" boolean DEFAULT false NOT NULL,
	"browser" text,
	"os" text,
	"device_type" text,
	"country" text,
	"player_name" text,
	"video_title" text,
	"page_url" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"response_body" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"type" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drm_configs" ADD CONSTRAINT "drm_configs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drm_keys" ADD CONSTRAINT "drm_keys_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_segments" ADD CONSTRAINT "live_segments_live_stream_id_live_streams_id_fk" FOREIGN KEY ("live_stream_id") REFERENCES "public"."live_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_streams" ADD CONSTRAINT "live_streams_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_ids" ADD CONSTRAINT "playback_ids_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_ids" ADD CONSTRAINT "playback_ids_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys" ADD CONSTRAINT "signing_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulcast_targets" ADD CONSTRAINT "simulcast_targets_live_stream_id_live_streams_id_fk" FOREIGN KEY ("live_stream_id") REFERENCES "public"."live_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_env" ON "api_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "assets_env_created" ON "assets" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE INDEX "assets_live" ON "assets" USING btree ("live_stream_id");--> statement-breakpoint
CREATE INDEX "live_segments_session" ON "live_segments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "live_streams_env" ON "live_streams" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_email" ON "memberships" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "playback_ids_asset" ON "playback_ids" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "playback_ids_live" ON "playback_ids" USING btree ("live_stream_id");--> statement-breakpoint
CREATE INDEX "signing_keys_env" ON "signing_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "tracks_asset" ON "tracks" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "uploads_status" ON "uploads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "views_env_started" ON "views" USING btree ("environment_id","started_at");--> statement-breakpoint
CREATE INDEX "views_asset" ON "views" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_env" ON "webhook_endpoints" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "webhook_events_env_created" ON "webhook_events" USING btree ("environment_id","created_at");