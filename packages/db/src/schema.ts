import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  bigserial,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

/* ----------------------------- Accounts ----------------------------- */

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
    status: text("status", { enum: ["active", "invited"] }).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_org_email").on(t.orgId, t.email)],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const environments = pgTable("environments", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["development", "production"] }).notNull().default("development"),
  createdAt: createdAt(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // public token id
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    permissions: text("permissions", { enum: ["full", "read"] }).notNull().default("full"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_env").on(t.environmentId)],
);

export const signingKeys = pgTable(
  "signing_keys",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("signing_keys_env").on(t.environmentId)],
);

/* ------------------------------ Video ------------------------------ */

export type Rendition = {
  name: string;
  width: number;
  height: number;
  bitrate: number;
  codec: string;
};

export type StaticRendition = {
  name: string;
  ext: "mp4" | "m4a";
  width?: number;
  height?: number;
  bitrate?: number;
  filesize?: number;
  status: "preparing" | "ready" | "errored";
};

export type AssetInputSettings = {
  url?: string;
  start_time?: number;
  end_time?: number;
  overlay_settings?: {
    vertical_align?: "top" | "middle" | "bottom";
    horizontal_align?: "left" | "center" | "right";
    vertical_margin?: string;
    horizontal_margin?: string;
    width?: string;
    opacity?: string;
  };
  type?: "video" | "audio" | "text";
  text_type?: "subtitles";
  language_code?: string;
  name?: string;
  closed_captions?: boolean;
  generated_subtitles?: { language_code: string; name?: string }[];
};

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["preparing", "ready", "errored"] }).notNull().default("preparing"),
    duration: real("duration"),
    aspectRatio: text("aspect_ratio"),
    maxWidth: integer("max_width"),
    maxHeight: integer("max_height"),
    maxFrameRate: real("max_frame_rate"),
    resolutionTier: text("resolution_tier"),
    maxResolutionTier: text("max_resolution_tier", { enum: ["1080p", "1440p", "2160p"] }).notNull().default("1080p"),
    videoQuality: text("video_quality", { enum: ["basic", "plus", "premium"] }).notNull().default("plus"),
    mp4Support: text("mp4_support", { enum: ["none", "capped-1080p", "audio-only", "standard"] }).notNull().default("none"),
    normalizeAudio: boolean("normalize_audio").notNull().default(false),
    protection: text("protection", { enum: ["none", "aes-128", "drm"] }).notNull().default("none"),
    passthrough: text("passthrough"),
    title: text("title"),
    uploadId: text("upload_id"),
    liveStreamId: text("live_stream_id"),
    isLive: boolean("is_live").notNull().default(false),
    sourceKey: text("source_key"),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
    input: jsonb("input").$type<AssetInputSettings[]>().notNull().default([]),
    renditions: jsonb("renditions").$type<Rendition[]>().notNull().default([]),
    staticRenditions: jsonb("static_renditions").$type<StaticRendition[]>().notNull().default([]),
    hasStoryboard: boolean("has_storyboard").notNull().default(false),
    hasDash: boolean("has_dash").notNull().default(false),
    errors: jsonb("errors").$type<{ type: string; messages: string[] } | null>(),
    ai: jsonb("ai").$type<{
      summary?: string;
      tags?: string[];
      chapters?: { start_time: number; title: string }[];
    } | null>(),
    progress: jsonb("progress").$type<{ state: string; progress: number } | null>(),
    test: boolean("test").notNull().default(false),
    createdAt: createdAt(),
    readyAt: ts("ready_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("assets_env_created").on(t.environmentId, t.createdAt), index("assets_live").on(t.liveStreamId)],
);

export const tracks = pgTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["video", "audio", "text"] }).notNull(),
    textType: text("text_type"),
    textSource: text("text_source", { enum: ["uploaded", "generated", "translated"] }),
    languageCode: text("language_code"),
    name: text("name"),
    closedCaptions: boolean("closed_captions").notNull().default(false),
    status: text("status", { enum: ["preparing", "ready", "errored"] }).notNull().default("preparing"),
    storageKey: text("storage_key"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("tracks_asset").on(t.assetId)],
);

export const playbackIds = pgTable(
  "playback_ids",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    liveStreamId: text("live_stream_id"),
    policy: text("policy", { enum: ["public", "signed", "drm"] }).notNull().default("public"),
    createdAt: createdAt(),
  },
  (t) => [index("playback_ids_asset").on(t.assetId), index("playback_ids_live").on(t.liveStreamId)],
);

export const uploads = pgTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["waiting", "asset_created", "errored", "cancelled", "timed_out"] })
      .notNull()
      .default("waiting"),
    corsOrigin: text("cors_origin"),
    newAssetSettings: jsonb("new_asset_settings").$type<Record<string, unknown>>().notNull().default({}),
    assetId: text("asset_id"),
    storageKey: text("storage_key").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    test: boolean("test").notNull().default(false),
    error: jsonb("error").$type<{ type: string; message: string } | null>(),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("uploads_status").on(t.status)],
);

/* ------------------------------- Live ------------------------------- */

export const liveStreams = pgTable(
  "live_streams",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    streamKey: text("stream_key").notNull().unique(),
    status: text("status", { enum: ["idle", "active", "disabled"] }).notNull().default("idle"),
    connected: boolean("connected").notNull().default(false),
    latencyMode: text("latency_mode", { enum: ["low", "reduced", "standard"] }).notNull().default("low"),
    reconnectWindow: integer("reconnect_window").notNull().default(60),
    recording: boolean("recording").notNull().default(true),
    newAssetSettings: jsonb("new_asset_settings").$type<Record<string, unknown>>().notNull().default({}),
    activeAssetId: text("active_asset_id"),
    activeSessionId: text("active_session_id"),
    recentAssetIds: jsonb("recent_asset_ids").$type<string[]>().notNull().default([]),
    passthrough: text("passthrough"),
    title: text("title"),
    health: jsonb("health").$type<Record<string, unknown> | null>(),
    lastActiveAt: ts("last_active_at"),
    lastDisconnectedAt: ts("last_disconnected_at"),
    createdAt: createdAt(),
  },
  (t) => [index("live_streams_env").on(t.environmentId)],
);

export const liveSegments = pgTable(
  "live_segments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    liveStreamId: text("live_stream_id").notNull().references(() => liveStreams.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("live_segments_session").on(t.sessionId)],
);

export const simulcastTargets = pgTable("simulcast_targets", {
  id: text("id").primaryKey(),
  liveStreamId: text("live_stream_id").notNull().references(() => liveStreams.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  streamKey: text("stream_key"),
  passthrough: text("passthrough"),
  status: text("status", { enum: ["idle", "starting", "broadcasting", "errored"] }).notNull().default("idle"),
  createdAt: createdAt(),
});

/* -------------------------------- DRM -------------------------------- */

export const drmKeys = pgTable("drm_keys", {
  assetId: text("asset_id").primaryKey().references(() => assets.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(), // hex, 16 bytes
  keyEnc: text("key_enc").notNull(), // AES-GCM encrypted content key
  ivHex: text("iv_hex").notNull(), // content IV (hex, 16 bytes) used by the packager
  createdAt: createdAt(),
});

export type DrmSettings = {
  /** clearkey = built-in, browser-only test DRM. proxy = forward to a multi-DRM provider. */
  provider: "clearkey" | "proxy";
  widevine_license_url?: string;
  playready_license_url?: string;
  fairplay_license_url?: string;
  fairplay_certificate_url?: string;
  /** Extra headers sent with every proxied license request (e.g. provider auth). */
  license_headers?: Record<string, string>;
  /** Optional URL we POST {asset_id, key_id, key} to when a new content key is created. */
  key_registration_url?: string;
  key_registration_headers?: Record<string, string>;
};

export const drmConfigs = pgTable("drm_configs", {
  environmentId: text("environment_id")
    .primaryKey()
    .references(() => environments.id, { onDelete: "cascade" }),
  settingsEnc: text("settings_enc").notNull(), // encrypted JSON of DrmSettings
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/* ------------------------------ Webhooks ------------------------------ */

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull().default(["*"]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_endpoints_env").on(t.environmentId)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_events_env_created").on(t.environmentId, t.createdAt)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().references(() => webhookEvents.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "success", "failed"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    lastAttemptAt: ts("last_attempt_at"),
    createdAt: createdAt(),
  },
  (t) => [index("webhook_deliveries_endpoint").on(t.endpointId, t.createdAt)],
);

/* ------------------------------ Analytics ------------------------------ */

export const views = pgTable(
  "views",
  {
    id: text("id").primaryKey(),
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    playbackId: text("playback_id").notNull(),
    assetId: text("asset_id"),
    liveStreamId: text("live_stream_id"),
    viewerId: text("viewer_id"),
    startedAt: ts("started_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    watchTimeMs: integer("watch_time_ms").notNull().default(0),
    startupMs: integer("startup_ms"),
    rebufferCount: integer("rebuffer_count").notNull().default(0),
    rebufferMs: integer("rebuffer_ms").notNull().default(0),
    seekCount: integer("seek_count").notNull().default(0),
    maxHeight: integer("max_height"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    exited: boolean("exited").notNull().default(false),
    browser: text("browser"),
    os: text("os"),
    deviceType: text("device_type"),
    country: text("country"),
    playerName: text("player_name"),
    videoTitle: text("video_title"),
    pageUrl: text("page_url"),
  },
  (t) => [
    index("views_env_started").on(t.environmentId, t.startedAt),
    index("views_asset").on(t.assetId),
  ],
);

/* ------------------------------ Usage ------------------------------ */

export const usageDaily = pgTable(
  "usage_daily",
  {
    environmentId: text("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    day: text("day").notNull(), // YYYY-MM-DD
    encodedSeconds: real("encoded_seconds").notNull().default(0),
    storedSeconds: real("stored_seconds").notNull().default(0),
    deliveredSeconds: real("delivered_seconds").notNull().default(0),
    liveSeconds: real("live_seconds").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.day] })],
);
