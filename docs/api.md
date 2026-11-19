# Vela API reference

Base URL: `API_PUBLIC_URL` (default `http://localhost:4000`). All management endpoints live under `/v1`.

**Authentication:** HTTP Basic with an access token (`-u TOKEN_ID:TOKEN_SECRET`). Each token belongs to one environment. Read-only tokens can only use `GET`. The dashboard uses a session cookie plus an `X-Vela-Environment` header instead.

**Responses:** objects are wrapped as `{ "data": ... }`. Lists of assets, uploads, live streams, events, webhook deliveries and `/v1/data/views` add `"pagination": { "page", "limit", "total" }` and accept `?page=&limit=` (default 25, max 100). The small configuration lists (`/v1/signing-keys`, `/v1/webhooks`, `/v1/api-keys`) return every item and have no `pagination`. Errors look like `{ "error": { "type": "invalid_parameters", "messages": ["..."] } }`.

## Assets

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/assets` | Create from URL. Body below. |
| GET | `/v1/assets` | Filters: `status`, `live_stream_id`, `upload_id`, `q` (title/passthrough/id) |
| GET | `/v1/assets/:id` | |
| PATCH | `/v1/assets/:id` | `{ title, passthrough }` |
| DELETE | `/v1/assets/:id` | Removes playback IDs and all stored files |
| GET | `/v1/assets/:id/input-info` | Probe data of the source |
| GET | `/v1/assets/:id/master` | 24-hour download URL for the original file |
| POST | `/v1/assets/:id/playback-ids` | `{ policy: "public" \| "signed" \| "drm" }` |
| GET/DELETE | `/v1/assets/:id/playback-ids/:pid` | |
| PUT | `/v1/assets/:id/mp4-support` | `{ mp4_support: "none" \| "capped-1080p" \| "audio-only" \| "standard" }` |
| POST | `/v1/assets/:id/tracks` | Add subtitles: `{ url, language_code, name, closed_captions }` |
| DELETE | `/v1/assets/:id/tracks/:tid` | |
| POST | `/v1/assets/:id/generate-subtitles` | `{ language_code, name }` (needs `TRANSCRIPTION_PROVIDER`) |
| POST | `/v1/assets/:id/tracks/:tid/translate` | `{ language_code, name }` (needs an LLM) |
| POST | `/v1/assets/:id/insights` | Summary, tags and chapters into `asset.ai` |
| POST | `/v1/assets/:id/clips` | `{ start_time, end_time, ...settings }` creates a new asset |

Create body:

```json
{
  "input": "https://example.com/video.mp4",
  "playback_policies": ["public"],
  "protection": "none",
  "video_quality": "plus",
  "max_resolution_tier": "1080p",
  "mp4_support": "none",
  "normalize_audio": false,
  "title": "Launch video",
  "passthrough": "your-own-id",
  "generate_insights": false
}
```

`input` can also be an array, for example to add subtitles, auto captions or a watermark in one call:

```json
{
  "input": [
    { "url": "https://example.com/video.mp4", "generated_subtitles": [{ "language_code": "en" }] },
    { "url": "https://example.com/subs-fr.vtt", "type": "text", "language_code": "fr", "name": "Français" },
    { "url": "https://example.com/logo.png", "overlay_settings": { "vertical_align": "top", "horizontal_align": "right", "width": "12%", "opacity": "80%" } }
  ],
  "playback_policies": ["signed"]
}
```

- `playback_policies: ["drm"]` encrypts with CENC for Widevine, PlayReady and FairPlay.
- `protection: "aes-128"` encrypts HLS segments with AES-128.
- Clip another asset with `{ "url": "vela://assets/ASSET_ID", "start_time": 10, "end_time": 25 }`. A clip gets its own master file (just that range), so it keeps working if the original is deleted.
- `max_resolution_tier: "2160p"` keeps 4K renditions.
- Input, subtitle and overlay URLs must be `http(s)://`. Hosts that are or resolve to private, loopback, link-local or other non-public addresses (including after redirects) are refused with `400 invalid_parameters` (or the asset errors if the check fails at download time), unless the server sets `ALLOW_PRIVATE_INPUT_URLS=true`.

Asset `status` is `preparing`, then `ready` or `errored`. `progress` shows `{ state, progress }` while it's processing.

## Direct uploads

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/uploads` | `{ new_asset_settings, cors_origin, timeout }` returns `url`; `PUT` the file body there |
| POST | `/v1/uploads/:id/complete` | Optional; starts processing immediately (otherwise detected within ~15 s) |
| GET | `/v1/uploads`, `/v1/uploads/:id` | |
| PUT | `/v1/uploads/:id/cancel` | |

## Live streams

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/live-streams` | `{ playback_policies, new_asset_settings, reconnect_window, latency_mode, recording, title, simulcast_targets }` |
| GET | `/v1/live-streams`, `/v1/live-streams/:id` | Includes `stream_key` and `ingest` URLs |
| PATCH | `/v1/live-streams/:id` | |
| DELETE | `/v1/live-streams/:id` | |
| POST | `/v1/live-streams/:id/reset-stream-key` | |
| PUT | `/v1/live-streams/:id/disable`, `/enable` | |
| PUT | `/v1/live-streams/:id/complete` | End the session now instead of waiting for the reconnect window |
| POST/DELETE | `/v1/live-streams/:id/playback-ids[/:pid]` | |
| POST/DELETE | `/v1/live-streams/:id/simulcast-targets[/:tid]` | `{ url: "rtmp://…", stream_key }` |

Ingest: RTMP `rtmp://HOST:1935/live` with the stream key, or SRT `srt://HOST:8890?streamid=publish:live/STREAM_KEY`.

## Other

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/playback-ids/:id` | Which asset or live stream a playback ID belongs to |
| GET/POST/DELETE | `/v1/signing-keys[/:id]` | `POST` returns `private_key` (base64 PEM) once |
| GET/POST/PATCH/DELETE | `/v1/webhooks[/:id]` | `{ url, events: ["*"] }` |
| POST | `/v1/webhooks/:id/test`, `/v1/webhooks/:id/rotate-secret` | |
| GET | `/v1/webhooks/:id/deliveries`, `/v1/webhooks/event-types` | |
| POST | `/v1/webhooks/deliveries/:did/redeliver` | |
| GET | `/v1/events` | Event log (`type`, `object_id` filters) |
| GET/PUT | `/v1/drm` | DRM provider settings |
| GET | `/v1/data/overview`, `/timeseries`, `/breakdown?dimension=`, `/realtime`, `/views` | `timeframe=24h\|7d\|30d\|90d`, `asset_id`, `live_stream_id` |
| GET | `/v1/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` | |
| GET/POST/DELETE | `/v1/api-keys` | Dashboard session only |
| GET/PATCH | `/v1/org`; POST/PATCH/DELETE `/v1/environments`, `/v1/members` | Dashboard session only |

## Playback (stream service, `STREAM_PUBLIC_URL`)

| Path | Notes |
|---|---|
| `/:playbackId.m3u8` | HLS. `?token=` for signed/DRM; `?max_resolution=720p`, `?min_resolution=` |
| `/:playbackId.mpd` | DASH (DRM assets) |
| `/:playbackId/thumbnail.(jpg\|png\|webp)` | `time`, `width`, `height`, `fit_mode=preserve\|crop\|pad\|stretch` |
| `/:playbackId/animated.(gif\|webp)` | `start`, `end` (≤10 s), `width`, `height`, `fps` |
| `/:playbackId/storyboard.(jpg\|vtt\|json)` | Seek-preview sprites |
| `/:playbackId/chapters.vtt` | From AI insights |
| `/:playbackId/capped-1080p.mp4` (etc.) | Static renditions; `?download=filename` |
| `/:playbackId/playback-info` | What the player needs (protection, DRM endpoints, tracks) |
| `/embed/:playbackId` | Hosted player page: `token`, `autoplay`, `muted`, `loop`, `start-time`, `watermark-text`, `primary-color` |
| `/player.js` | `<vela-player>` web component |
| `POST /license/(widevine\|playready\|fairplay\|clearkey)/:playbackId?token=` | DRM licenses |
| `GET /license/fairplay/:playbackId/cert` | FairPlay certificate |
| `POST /data/events` | Player analytics beacons |

**Token claims (RS256, header `kid` = signing key ID):** `sub` = playback ID, `aud` = `v` / `t` / `g` / `s` / `d`, `exp` (required). Optional: `viewer_id`, `max_resolution`.
