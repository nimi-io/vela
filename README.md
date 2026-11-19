# Vela

Self-hosted video infrastructure: upload, encode, stream, broadcast live, protect with DRM and measure playback. It does what Mux does, but runs on your own servers and stores everything in any S3-compatible bucket. Locally it runs on [Garage](https://garagehq.deuxfleurs.fr), a lightweight self-hosted S3-compatible store; in production use Cloudflare R2 (the cheapest option, no egress fees) or AWS S3.

## What's included

| Area | Features |
|---|---|
| **Video** | Direct browser uploads (presigned), import from URL, content-aware ABR ladder up to 4K, HLS with CMAF/fMP4, clips, watermark overlays, loudness normalisation, MP4/M4A downloads, master file access |
| **Protection** | Public, signed (RS256 JWT) and DRM playback IDs; AES-128 encryption; CENC `cbcs` DRM for Widevine, PlayReady and FairPlay through any multi-DRM provider, plus a built-in ClearKey test mode; per-viewer moving watermark in the player |
| **Live** | RTMP and SRT ingest (MediaMTX), low-latency HLS, reconnect windows, automatic recording to VOD, simulcast to YouTube/Twitch/any RTMP, stream key reset/disable |
| **Images** | Thumbnails at any time/size/fit, animated GIF/WebP, storyboard sprites + WebVTT for seek previews |
| **Captions & AI** | Uploaded subtitles (VTT/SRT/…), auto-generated captions (OpenAI-compatible Whisper or Cloudflare Workers AI), translated subtitles, AI summaries, tags and chapters |
| **Player** | `<vela-player>` web component (Shaka Player): HLS/DASH, all DRM systems, captions, quality menu, storyboard previews, chapters, PiP, Cast, built-in QoE analytics; hosted iframe embed |
| **Analytics** | Views, unique viewers, watch time, startup time, rebuffering, failures, experience score, breakdowns by video/browser/OS/device/country, real-time viewers |
| **Platform** | REST API with API keys, webhooks (signed, retried, delivery log, redeliver), event log, teams with roles, multiple environments, usage metering, Node SDK, dashboard |

## Architecture

```
            browser / app                         OBS / encoder
                 │                                      │ RTMP / SRT
   ┌─────────────┼───────────────┐                ┌─────▼─────┐
   │             │               │                │ MediaMTX  │──hooks──┐
   ▼             ▼               ▼                └─────┬─────┘         │
 API +        Stream          S3 / R2  ◄──presigned PUT─┘ LL-HLS        │
 dashboard    (playback,      (all media)                               │
 :4000        thumbnails,         ▲                                     │
   │          DRM licenses,       │                                     │
   │          analytics) :4100    │                                     │
   │             │                │                                     │
   ├──── Postgres (metadata, analytics) ─────────┐                      │
   └──── Redis / BullMQ (jobs) ──► Worker(s): ffmpeg, Shaka Packager, ◄─┘
                                   captions, webhooks, recordings, simulcast
```

| Service | Language | What it does |
|---|---|---|
| `apps/api` | TypeScript (Hono, Node 22) | REST API, auth, dashboard hosting, MediaMTX auth/hooks |
| `apps/worker` | TypeScript + ffmpeg + Shaka Packager | Transcoding, packaging, DRM encryption, thumbnails, captions/AI, webhooks, live recordings, simulcast, upload detection |
| `apps/stream` | TypeScript (Hono) | Playback: manifest rewriting, token checks, segment delivery, images, DRM license proxy, analytics intake, embed page |
| `apps/dashboard` | React + Vite | The web interface |
| `packages/player` | TypeScript (Shaka Player) | `<vela-player>` web component |
| `packages/sdk-node` | TypeScript | Server SDK, playback-token signing, webhook verification |
| `packages/core`, `packages/db` | TypeScript (Drizzle) | Shared config, storage, queues, schema and migrations |

Storage layout in the bucket: `assets/<id>/source` (master), `assets/<id>/hls/…`, `assets/<id>/dash/…` (DRM only), `assets/<id>/storyboard/…`, `assets/<id>/thumbs/…` (cache), `assets/<id>/static/…` (MP4s), `assets/<id>/text/…` (subtitles), `uploads/<id>/source` (pending uploads), `live/…` (recording segments).

## Quick start (one machine)

Requirements: Docker with Compose.

```bash
cp .env.example .env
# Fill in the secrets in .env:
#   MASTER_KEY, INTERNAL_SECRET, GARAGE_RPC_SECRET:  openssl rand -hex 32
#   GARAGE_ADMIN_TOKEN:                              openssl rand -base64 32
#   S3_ACCESS_KEY_ID:  echo GK$(openssl rand -hex 12)     S3_SECRET_ACCESS_KEY:  openssl rand -hex 32
docker compose up -d --build
# Allow browser uploads to Garage (one time; sets CORS on the bucket):
node --env-file=.env scripts/setup-bucket.mjs --origins http://localhost:4000
```

Storage is [Garage](https://garagehq.deuxfleurs.fr) (`dxflrs/garage`, config in `infra/garage.toml`), with its S3 API on http://localhost:3900 (region `garage`). On every start the one-shot `garage-init` service (`infra/garage-init.mjs`) assigns the single-node layout, creates the `vela` bucket and imports the access key from `.env`; it is safe to re-run. Inspect it with the CLI: `docker compose exec garage /garage bucket info vela`, or with any S3 client: `aws --endpoint-url http://localhost:3900 --region garage s3 ls s3://vela`.

Open http://localhost:4000 and create an account. The first account always works; set `SIGNUPS_ENABLED=false` afterwards if the instance is private. You get a Development and a Production environment.

- Upload a video on the **Videos** page, or import one with `POST /v1/assets`.
- Go live: create a stream under **Live streams**, then in OBS use the server `rtmp://localhost:1935/live` and the stream key shown.
- Use the API: create a key under **API keys**.

```bash
curl http://localhost:4000/v1/assets -u $TOKEN_ID:$TOKEN_SECRET \
  -H "Content-Type: application/json" \
  -d '{"input":"https://example.com/video.mp4","playback_policy":"public"}'
```

Playback URL: `http://localhost:4100/<PLAYBACK_ID>.m3u8`. Embed:

```html
<iframe src="http://localhost:4100/embed/PLAYBACK_ID" style="width:100%;aspect-ratio:16/9;border:0"
  allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe>
```

Or use the web component:

```html
<script src="https://stream.example.com/player.js" defer></script>
<vela-player playback-id="PLAYBACK_ID" token="JWT_IF_SIGNED"></vela-player>
```

## Production with Cloudflare R2

Garage is the local default; for production use R2 (or AWS S3) instead.

1. Create an R2 bucket and an R2 API token with Object Read & Write. Put the values in `.env` (see the R2 block in `.env.example`) and clear `S3_PUBLIC_ENDPOINT`.
2. Allow browser uploads: `pnpm setup:bucket -- --origins https://app.example.com` (or run `node --env-file=.env scripts/setup-bucket.mjs`).
3. Start without Garage: `docker compose up -d --build --scale garage=0 --scale garage-init=0`.
4. Put the services behind HTTPS (Caddy, nginx, Cloudflare Tunnel…). Set `API_PUBLIC_URL`, `STREAM_PUBLIC_URL`, `DASHBOARD_URL` to the public URLs and `SESSION_COOKIE_SECURE=true`.
5. Put a CDN in front of the stream service (for example a Cloudflare-proxied `stream.example.com`). Segment responses are `immutable` and cache well. Manifests are short-lived. Alternatively set `STREAM_SEGMENT_MODE=redirect` to send segment traffic straight to R2 with presigned URLs.
6. Expose MediaMTX ports 1935/tcp (RTMP) and 8890/udp (SRT) and set `LIVE_RTMP_PUBLIC_URL` / `LIVE_SRT_PUBLIC_URL`. For RTMPS, terminate TLS in front of 1935 and set `LIVE_RTMPS_PUBLIC_URL`.
7. Do not expose `/internal/*` on the API publicly (block it at your proxy). MediaMTX reaches the API over the private network.

### Scaling

- **Encoding** is the expensive part. Run more workers with `docker compose up -d --scale worker=4`, or put workers on separate machines that point at the same Postgres, Redis and bucket. Use `WORKER_QUEUES=video` on dedicated encode boxes, `TRANSCODE_CONCURRENCY` to run several encodes per box, and `HW_ACCEL=nvenc` on NVIDIA machines.
- **Stream** and **API** are stateless, so run as many replicas as you need behind a load balancer.
- **Live recordings:** MediaMTX and the worker that handles the `live` queue must share the recordings volume, so run at least one `live` worker on the MediaMTX host.
- The **API** runs database migrations on start. Set `RUN_MIGRATIONS=false` on all but one replica if you prefer.

## DRM

DRM assets are encoded once with CENC `cbcs` (Shaka Packager) into HLS and DASH, with PSSH/key info for Widevine, PlayReady and FairPlay. Each asset gets its own content key, stored encrypted with `MASTER_KEY`.

- **Test mode (default):** the built-in ClearKey server lets DRM videos play in Chrome, Edge and Firefox without a provider. Keys reach the browser, so this is for development only.
- **Production:** under **DRM**, choose *Multi-DRM provider* and enter your provider's license URLs and auth headers (EZDRM, Axinom, DoveRunner/PallyCon, BuyDRM, …). The stream service checks the viewer's token, then proxies the license request. Header values can use `{asset_id}`, `{key_id}`, `{key_id_uuid}`, `{viewer_id}`, `{playback_id}`. Set a *key registration URL* to receive each new content key so your provider can issue licenses for it.
- **FairPlay** needs a deployment package from Apple (apply through the Apple Developer program). Your provider usually hosts the certificate; enter its URL.

DRM playback IDs require a signed token. Downloads (MP4) are disabled for DRM assets.

## Signed playback

Create a signing key (dashboard or `POST /v1/signing-keys`). Keep the private key on your server and sign short-lived tokens:

```ts
import { signPlaybackToken } from "@vela/node";
const token = await signPlaybackToken(playbackId, { keyId, privateKey, expiresIn: "2h", claims: { viewer_id: user.id } });
// https://stream.example.com/PLAYBACK_ID.m3u8?token=...
```

The token audience is `v` (video, which also covers thumbnails and storyboards), `t`, `g`, `s` or `d` (DRM license). An optional `max_resolution` claim caps quality.

## Webhooks

Events are POSTed as JSON with a `Vela-Signature: t=<unix>,v1=<hmac-sha256(secret, "t.body")>` header. Verify with `verifyWebhook(rawBody, header, secret)` from `@vela/node`. Main events: `video.asset.created|ready|errored|deleted|updated`, `video.asset.static_renditions.ready`, `video.asset.track.ready|errored`, `video.asset.live_stream_completed`, `video.upload.created|asset_created|cancelled`, `video.live_stream.created|connected|active|disconnected|idle|deleted`. Full list: `GET /v1/webhooks/event-types`.

## Development

```bash
pnpm install
cp .env.example .env    # point S3_* at Garage (http://localhost:3900) or R2, set DATABASE_URL/REDIS_URL to local services
pnpm db:migrate
pnpm dev                # api :4000, stream :4100, worker, dashboard :5173 (proxies the API)
pnpm typecheck && pnpm test
node scripts/smoke-test.mjs --video ./sample.mp4   # end-to-end check against a running stack
```

The worker needs `ffmpeg`/`ffprobe` and, for DRM, [Shaka Packager](https://github.com/shaka-project/shaka-packager/releases) on `PATH` (the Docker image includes both).

API reference: [docs/api.md](docs/api.md).
