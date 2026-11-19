import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Any S3-compatible storage: Garage (local default), Cloudflare R2, AWS S3, Backblaze B2, Wasabi...
  S3_ENDPOINT: z.string().optional(),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
  S3_ACCESS_KEY_ID: z.string().min(1, "S3_ACCESS_KEY_ID is required"),
  S3_SECRET_ACCESS_KEY: z.string().min(1, "S3_SECRET_ACCESS_KEY is required"),
  S3_FORCE_PATH_STYLE: bool(true),

  // 32+ random bytes (hex or base64). Encrypts DRM keys/secrets and signs internal tokens.
  MASTER_KEY: z.string().min(32, "MASTER_KEY must be at least 32 characters"),
  INTERNAL_SECRET: z.string().default("change-me-internal"),

  API_PORT: z.coerce.number().default(4000),
  STREAM_PORT: z.coerce.number().default(4100),
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  STREAM_PUBLIC_URL: z.string().default("http://localhost:4100"),
  DASHBOARD_URL: z.string().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default(""),
  SESSION_COOKIE_SECURE: bool(false),
  SESSION_COOKIE_DOMAIN: z.string().optional(),
  SIGNUPS_ENABLED: bool(true),

  // How segments are served: "proxy" streams through the stream service (CDN-cacheable),
  // "redirect" 302s to short-lived presigned storage URLs.
  STREAM_SEGMENT_MODE: z.enum(["proxy", "redirect"]).default("proxy"),

  // Live
  MEDIAMTX_HLS_URL: z.string().default("http://localhost:8888"),
  MEDIAMTX_RTMP_URL: z.string().default("rtmp://localhost:1935"),
  LIVE_RTMP_PUBLIC_URL: z.string().default("rtmp://localhost:1935/live"),
  LIVE_RTMPS_PUBLIC_URL: z.string().optional(),
  LIVE_SRT_PUBLIC_URL: z.string().default("srt://localhost:8890"),
  RECORDINGS_DIR: z.string().default("/recordings"),

  // Media tooling
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  PACKAGER_PATH: z.string().default("packager"),
  WORK_DIR: z.string().default("/tmp/vela-work"),
  TRANSCODE_CONCURRENCY: z.coerce.number().default(1),
  X264_PRESET: z.string().default("veryfast"),
  HW_ACCEL: z.enum(["none", "nvenc"]).default("none"),

  // AI (optional)
  TRANSCRIPTION_PROVIDER: z.enum(["none", "openai", "cloudflare"]).default("none"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  WHISPER_MODEL: z.string().default("whisper-1"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_WHISPER_MODEL: z.string().default("@cf/openai/whisper-large-v3-turbo"),
  CLOUDFLARE_LLM_MODEL: z.string().default("@cf/meta/llama-3.1-8b-instruct"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests. */
export function resetEnv() {
  cached = undefined;
}
