import {
  getDb,
  assets,
  tracks,
  playbackIds,
  uploads,
  eq,
  and,
  isNull,
  type AssetInputSettings,
} from "@vela/db";
import { z } from "zod";
import { randomId } from "./crypto.js";
import { enqueue } from "./queues.js";
import { emitEvent } from "./webhooks.js";
import { assetJson } from "./serialize.js";
import { storage, keys } from "./storage.js";

export const playbackPolicy = z.enum(["public", "signed", "drm"]);

const inputItem = z.object({
  url: z.string().optional(),
  start_time: z.number().min(0).optional(),
  end_time: z.number().min(0).optional(),
  type: z.enum(["video", "audio", "text"]).optional(),
  text_type: z.literal("subtitles").optional(),
  language_code: z.string().max(16).optional(),
  name: z.string().max(200).optional(),
  closed_captions: z.boolean().optional(),
  overlay_settings: z
    .object({
      vertical_align: z.enum(["top", "middle", "bottom"]).optional(),
      horizontal_align: z.enum(["left", "center", "right"]).optional(),
      vertical_margin: z.string().optional(),
      horizontal_margin: z.string().optional(),
      width: z.string().optional(),
      opacity: z.string().optional(),
    })
    .optional(),
  generated_subtitles: z
    .array(z.object({ language_code: z.string().max(16), name: z.string().max(200).optional() }))
    .optional(),
});

export const newAssetSettingsSchema = z.object({
  input: z.union([z.string(), z.array(inputItem)]).optional(),
  playback_policy: z.union([playbackPolicy, z.array(playbackPolicy)]).optional(),
  playback_policies: z.array(playbackPolicy).optional(),
  protection: z.enum(["none", "aes-128", "drm"]).optional(),
  mp4_support: z.enum(["none", "capped-1080p", "audio-only", "standard"]).optional(),
  normalize_audio: z.boolean().optional(),
  video_quality: z.enum(["basic", "plus", "premium"]).optional(),
  max_resolution_tier: z.enum(["1080p", "1440p", "2160p"]).optional(),
  passthrough: z.string().max(255).optional(),
  title: z.string().max(512).optional(),
  test: z.boolean().optional(),
  generate_insights: z.boolean().optional(),
});

export type NewAssetSettings = z.infer<typeof newAssetSettingsSchema>;

export function normalizePolicies(s: NewAssetSettings): ("public" | "signed" | "drm")[] {
  const raw = s.playback_policies ?? s.playback_policy ?? [];
  return Array.isArray(raw) ? raw : [raw];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
  ) {
    super(message);
  }
}

export const DRM_MP4_MESSAGE = "mp4_support is not available for DRM assets: downloads would be unencrypted copies";

/** True when these settings produce a DRM-protected asset (as createAsset decides). */
export function isDrmSettings(s: Omit<NewAssetSettings, "input">): boolean {
  return s.protection === "drm" || normalizePolicies(s).includes("drm");
}

/**
 * Static MP4 renditions are never produced for DRM assets (they would be clear copies), so reject
 * the combination up front instead of storing an mp4_support that can never be fulfilled.
 */
export function assertMp4SupportAllowed(s: Omit<NewAssetSettings, "input">) {
  if (isDrmSettings(s) && s.mp4_support && s.mp4_support !== "none") {
    throw new ApiError(400, "invalid_parameters", DRM_MP4_MESSAGE);
  }
}

/**
 * Creates an asset row (+ playback IDs and declared text tracks) and queues processing.
 * `source` says where the media comes from: an uploaded object, a URL, or a live recording.
 */
export async function createAsset(
  environmentId: string,
  settings: NewAssetSettings,
  source: { uploadId?: string; sourceKey?: string; liveStreamId?: string; isLive?: boolean } = {},
  opts: { process?: boolean } = { process: true },
) {
  const db = getDb();
  const inputs: AssetInputSettings[] =
    typeof settings.input === "string" ? [{ url: settings.input }] : (settings.input ?? []);

  const primary = inputs.find((i) => !i.type || i.type === "video") ?? inputs[0];
  if (!source.sourceKey && !source.liveStreamId && !primary?.url) {
    throw new ApiError(400, "invalid_parameters", "input must include a url");
  }

  if (primary?.url?.startsWith("vela://assets/")) {
    const srcId = primary.url.slice("vela://assets/".length);
    const [src] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, srcId), eq(assets.environmentId, environmentId), isNull(assets.deletedAt)));
    if (!src) throw new ApiError(400, "invalid_parameters", `source asset ${srcId} not found`);
  }

  const policies = normalizePolicies(settings);
  let protection = settings.protection ?? "none";
  if (policies.includes("drm")) protection = "drm";
  // Settings stored before an upload/recording completes may predate this check: drop MP4s then.
  const mp4Support = protection === "drm" ? "none" : (settings.mp4_support ?? "none");

  const id = randomId(24);
  const [asset] = await db
    .insert(assets)
    .values({
      id,
      environmentId,
      status: "preparing",
      input: inputs,
      mp4Support,
      normalizeAudio: settings.normalize_audio ?? false,
      videoQuality: settings.video_quality ?? "plus",
      maxResolutionTier: settings.max_resolution_tier ?? "1080p",
      protection,
      passthrough: settings.passthrough,
      title: settings.title,
      test: settings.test ?? false,
      uploadId: source.uploadId,
      sourceKey: source.sourceKey,
      liveStreamId: source.liveStreamId,
      isLive: source.isLive ?? false,
      progress: { state: "ingesting", progress: 0 },
      ai: settings.generate_insights ? { tags: [] } : null,
    })
    .returning();

  const pids = [];
  for (const policy of policies) {
    const [p] = await db
      .insert(playbackIds)
      .values({ id: randomId(32), environmentId, assetId: id, policy })
      .returning();
    pids.push(p!);
  }

  const trks = [];
  for (const inp of inputs) {
    if (inp.type === "text" && inp.url) {
      const [t] = await db
        .insert(tracks)
        .values({
          id: randomId(24),
          assetId: id,
          type: "text",
          textType: "subtitles",
          textSource: "uploaded",
          languageCode: inp.language_code ?? "en",
          name: inp.name ?? inp.language_code ?? "English",
          closedCaptions: inp.closed_captions ?? false,
          meta: { url: inp.url },
        })
        .returning();
      trks.push(t!);
    }
    for (const g of inp.generated_subtitles ?? []) {
      const [t] = await db
        .insert(tracks)
        .values({
          id: randomId(24),
          assetId: id,
          type: "text",
          textType: "subtitles",
          textSource: "generated",
          languageCode: g.language_code,
          name: g.name ?? `${g.language_code} (generated)`,
          closedCaptions: true,
        })
        .returning();
      trks.push(t!);
    }
  }

  if (opts.process !== false) await enqueue("asset.process", { assetId: id }, { attempts: 2 });
  await emitEvent(environmentId, "video.asset.created", assetJson(asset!, pids, trks), { type: "asset", id });
  return { asset: asset!, playbackIds: pids, tracks: trks };
}

/** Called when an upload's object is detected in storage (explicit /complete or the sweeper). */
export async function finalizeUpload(uploadId: string) {
  const db = getDb();
  const [u] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
  if (!u || u.status !== "waiting") return null;
  const head = await storage.head(u.storageKey);
  if (!head) return null;

  // Claim the upload atomically so a concurrent sweeper can't create a second asset.
  const claimed = await db
    .update(uploads)
    .set({ status: "asset_created" })
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, "waiting")))
    .returning();
  if (!claimed.length) return null;

  const settings = newAssetSettingsSchema.parse(u.newAssetSettings ?? {});
  const { asset } = await createAsset(
    u.environmentId,
    { ...settings, test: settings.test ?? u.test, input: undefined },
    { uploadId: u.id, sourceKey: keys.uploadSource(u.id) },
  );
  await db.update(uploads).set({ assetId: asset.id }).where(eq(uploads.id, uploadId));
  await emitEvent(
    u.environmentId,
    "video.upload.asset_created",
    { id: u.id, status: "asset_created", asset_id: asset.id },
    { type: "upload", id: u.id },
  );
  return asset;
}

export async function loadAssetJson(assetId: string) {
  const db = getDb();
  const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return null;
  const pids = await db.select().from(playbackIds).where(eq(playbackIds.assetId, assetId));
  const trks = await db.select().from(tracks).where(eq(tracks.assetId, assetId));
  return assetJson(a, pids, trks);
}
