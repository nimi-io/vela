import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";
import { useSession } from "../lib/session";
import { PageHead, Segmented, CopyField } from "../components/ui";
import { DocsCtx, readLang, storeLang, useDocs, CodeBlock, Sample, Step, curlCmd, nodeInit, js, type Lang, type DocVars } from "../components/docs";
import { ReferenceSection } from "./DocsReference";

type Asset = { id: string; title: string | null; duration: number | null; playback_ids: { id: string; policy: string }[] };

const SECTIONS = [
  { id: "quickstart", label: "Quickstart" },
  { id: "reference", label: "API reference" },
  { id: "uploads", label: "Direct uploads" },
  { id: "signed-playback", label: "Signed playback" },
  { id: "webhooks", label: "Webhooks" },
  { id: "live", label: "Live streaming" },
  { id: "drm", label: "DRM" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const trim = (u: string | undefined, fallback: string) => (u || fallback).replace(/\/+$/, "");

export function DocsPage() {
  const { section = "quickstart" } = useParams();
  const { config, env } = useSession();
  const [lang, setLangState] = useState<Lang>(readLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    storeLang(l);
  };

  // "Try it" prefill: the first ready video with a public playback ID in this environment.
  const assets = useQuery({ queryKey: ["docs-assets"], queryFn: () => get<Asset[]>("/v1/assets?limit=25&status=ready") });
  const asset = assets.data?.find((a) => a.playback_ids?.some((p) => p.policy === "public")) ?? null;
  const pid = asset?.playback_ids.find((p) => p.policy === "public")?.id;

  const v: DocVars = useMemo(
    () => ({
      api: trim(config?.api_url, "http://localhost:4000"),
      stream: trim(config?.stream_url, "http://localhost:4100"),
      assetId: asset?.id ?? "ASSET_ID",
      pid: pid ?? "PLAYBACK_ID",
      real: !!asset,
      title: asset?.title ?? null,
      duration: asset?.duration ?? null,
      envId: env?.id ?? "ENVIRONMENT_ID",
    }),
    [config, asset, pid, env],
  );

  if (!SECTIONS.some((s) => s.id === section)) return <Navigate to="/docs" replace />;

  return (
    <DocsCtx.Provider value={{ lang, setLang, v }}>
      <div className="page docs">
        <PageHead
          title="Docs"
          description="Guides and API reference for building on Vela. Every example uses this server's URLs."
          actions={
            <Segmented
              value={lang}
              onChange={setLang}
              options={[
                { value: "curl", label: "curl" },
                { value: "node", label: "Node.js" },
              ]}
            />
          }
        />
        <nav className="tabs doc-tabs" aria-label="Docs sections">
          {SECTIONS.map((s) => (
            <Link key={s.id} to={s.id === "quickstart" ? "/docs" : `/docs/${s.id}`} className={s.id === section ? "on" : ""} aria-current={s.id === section ? "page" : undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
        {!assets.isLoading && <PrefillNote />}
        <div className="stack">
          <Section id={section as SectionId} />
        </div>
      </div>
    </DocsCtx.Provider>
  );
}

function PrefillNote() {
  const { v } = useDocs();
  if (v.real)
    return (
      <p className="small muted doc-prefill">
        Examples use your video “{v.title || v.assetId}”.
      </p>
    );
  return (
    <p className="small muted doc-prefill">
      Examples use the placeholders <code>ASSET_ID</code> and <code>PLAYBACK_ID</code>. <Link to="/videos">Add a video</Link> with a public playback ID and they'll be filled in with real values.
    </p>
  );
}

function Section({ id }: { id: SectionId }) {
  switch (id) {
    case "quickstart":
      return <Quickstart />;
    case "reference":
      return <ReferenceSection />;
    case "uploads":
      return <Uploads />;
    case "signed-playback":
      return <SignedPlayback />;
    case "webhooks":
      return <Webhooks />;
    case "live":
      return <Live />;
    case "drm":
      return <Drm />;
  }
}

/* ------------------------------ Shared bits ------------------------------ */

function SdkNote() {
  return (
    <p>
      The Node SDK, <code>@vela/node</code>, lives in <code>packages/sdk-node</code> of the Vela repo and isn't published to npm: copy or link that folder into your project and install its one dependency, <code>jose</code>. It ships TypeScript source (<code>src/index.ts</code>), so run it with a TypeScript-aware runtime or bundler (for example <code>tsx</code>). SDK methods return the unwrapped <code>data</code> and throw a <code>VelaError</code> (with <code>status</code> and <code>type</code>) on errors.
    </p>
  );
}

function SignTokenSample({ audience = "v" }: { audience?: string }) {
  return (
    <CodeBlock
      label="Node.js"
      code={`import { signPlaybackToken } from "@vela/node";

const token = await signPlaybackToken("PLAYBACK_ID", {
  keyId: process.env.VELA_SIGNING_KEY_ID,
  privateKey: process.env.VELA_SIGNING_PRIVATE_KEY, // base64 PEM from POST /v1/signing-keys
  audience: "${audience}",
  expiresIn: "2h",
  claims: { viewer_id: "user-123", max_resolution: "1080p" }, // both optional
});`}
    />
  );
}

/* ------------------------------ Quickstart ------------------------------ */

function Quickstart() {
  const { v } = useDocs();
  const body = { input: "https://example.com/video.mp4", playback_policies: ["public"], title: "My first video" };
  const urls = [
    { label: "HLS", url: `${v.stream}/${v.pid}.m3u8` },
    { label: "Thumbnail", url: `${v.stream}/${v.pid}/thumbnail.jpg?time=5&width=640` },
    { label: "Animated GIF", url: `${v.stream}/${v.pid}/animated.gif?start=2&end=6` },
    { label: "Storyboard (seek previews)", url: `${v.stream}/${v.pid}/storyboard.vtt` },
    { label: "MP4 (needs mp4_support)", url: `${v.stream}/${v.pid}/capped-1080p.mp4` },
    { label: "Embed page", url: `${v.stream}/embed/${v.pid}` },
  ];
  return (
    <>
      <Step n={1} title="Create an access token">
        <p>
          Create a token on the <Link to="/api-keys">API keys</Link> page. Requests authenticate with HTTP Basic: the token ID is the username and the secret is the password. Each token belongs to the environment it was created in; read-only tokens can only make <code>GET</code> requests.
        </p>
        <CodeBlock
          label="Shell"
          code={`export VELA_TOKEN_ID="your-token-id"
export VELA_TOKEN_SECRET="your-token-secret"`}
        />
        <p>
          The API lives at <code>{v.api}</code>; every endpoint is under <code>/v1</code>. Responses are wrapped as <code>{'{ "data": ... }'}</code>; see the <Link to="/docs/reference">API reference</Link> for every endpoint and error type.
        </p>
      </Step>

      <Step n={2} title="Add a video">
        <p>Create an asset from a URL Vela can download (it must be publicly reachable over http or https).</p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/assets`, body)}
          node={`${nodeInit(v.api)}
const asset = await vela.assets.create(${js(body)});
console.log(asset.id, asset.status); // "preparing"`}
        />
        <SdkNote />
      </Step>

      <Step n={3} title="Wait until it's ready">
        <p>
          The asset's <code>status</code> goes from <code>preparing</code> to <code>ready</code> (or <code>errored</code>, with details in <code>errors</code>); <code>progress</code> shows how far processing is. Poll the asset, or better, get a <code>video.asset.ready</code> <Link to="/docs/webhooks">webhook</Link>.
        </p>
        <Sample
          curl={curlCmd("GET", `${v.api}/v1/assets/${v.assetId}`)}
          node={`const asset = await vela.assets.retrieve("${v.assetId}");
console.log(asset.status, asset.playback_ids); // [{ id, policy }]`}
        />
      </Step>

      <Step n={4} title="Play it">
        <p>
          Use the playback ID from <code>playback_ids</code> with the stream service at <code>{v.stream}</code>. The simplest option is the hosted player in an iframe:
        </p>
        <CodeBlock
          label="HTML"
          code={`<iframe
  src="${v.stream}/embed/${v.pid}"
  style="width: 100%; aspect-ratio: 16 / 9; border: 0"
  allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
  allowfullscreen
></iframe>`}
        />
        <p>Or drop the web component into your own page:</p>
        <CodeBlock
          label="HTML"
          code={`<script src="${v.stream}/player.js" defer></script>
<vela-player playback-id="${v.pid}"></vela-player>`}
        />
        {v.real && (
          <figure className="doc-figure">
            <img className="doc-thumb" src={`${v.stream}/${v.pid}/thumbnail.jpg?width=480`} alt={`Thumbnail of ${v.title || v.assetId}`} />
            <figcaption className="small muted">Live thumbnail of “{v.title || v.assetId}”.</figcaption>
          </figure>
        )}
        <p>Every playback ID also gets these URLs:</p>
        <div className="stack-sm">
          {urls.map((u) => (
            <div key={u.label} className="doc-url">
              <span className="small muted">{u.label}</span>
              <CopyField value={u.url} label={u.label} />
            </div>
          ))}
        </div>
        <p className="small muted">
          Add <code>?max_resolution=720p</code> to the HLS URL to cap quality. MP4 files exist only when the asset has <code>mp4_support</code> enabled. For private videos see <Link to="/docs/signed-playback">Signed playback</Link>.
        </p>
      </Step>
    </>
  );
}

/* ------------------------------ Direct uploads ------------------------------ */

function Uploads() {
  const { v } = useDocs();
  const body = { cors_origin: "https://app.example.com", new_asset_settings: { playback_policies: ["public"] } };
  return (
    <>
      <Step n={1} title="Create an upload URL on your server">
        <p>
          Direct uploads let browsers send files straight to storage without passing through your server. Your backend creates an upload and hands its <code>url</code> to the browser. <code>new_asset_settings</code> takes the same fields as creating an asset (except <code>input</code>); <code>timeout</code> is how long the URL stays valid, in seconds (default 3600).
        </p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/uploads`, body)}
          node={`${nodeInit(v.api)}
const upload = await vela.uploads.create(${js(body)});
// Send upload.id and upload.url to the browser.`}
        />
        <p>
          The response has <code>id</code>, <code>status: "waiting"</code>, the presigned <code>url</code> and <code>expires_at</code>.
        </p>
      </Step>

      <Step n={2} title="PUT the file from the browser">
        <p>
          The browser sends the file as the raw request body with a <code>PUT</code>. Use <code>XMLHttpRequest</code> if you want progress events:
        </p>
        <CodeBlock
          label="Browser JavaScript"
          code={`function uploadFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(\`Upload failed (\${xhr.status})\`)));
    xhr.onerror = () => reject(new Error("Network error: is the bucket's CORS configured?"));
    xhr.send(file);
  });
}

await uploadFile(upload.url, input.files[0], (p) => console.log(Math.round(p * 100) + "%"));`}
        />
        <p>To try it from a terminal:</p>
        <CodeBlock label="curl" code={`curl --upload-file video.mp4 "UPLOAD_URL"`} />
        <div className="notice warn">
          Self-hosting: browsers can only <code>PUT</code> to the bucket if its CORS rules allow your site's origin (the upload's <code>cors_origin</code> is stored with the upload but doesn't change the bucket). Set them with <code>node --env-file=.env scripts/setup-bucket.mjs --origins https://app.example.com</code> (comma-separate several origins).
        </div>
      </Step>

      <Step n={3} title="Start processing (optional)">
        <p>
          Vela notices the uploaded file on its own within about 15 seconds. To start right away, complete the upload. It answers <code>409 upload_incomplete</code> if no file has arrived yet.
        </p>
        <Sample curl={curlCmd("POST", `${v.api}/v1/uploads/UPLOAD_ID/complete`)} node={`await vela.uploads.complete("UPLOAD_ID");`} />
      </Step>

      <Step n={4} title="Find the asset">
        <p>
          Once the file is picked up the upload's <code>status</code> becomes <code>asset_created</code> and <code>asset_id</code> points at the new asset. You also get a <code>video.upload.asset_created</code> <Link to="/docs/webhooks">webhook</Link>. Cancel an unused upload with <code>PUT /v1/uploads/:id/cancel</code>.
        </p>
        <Sample
          curl={curlCmd("GET", `${v.api}/v1/uploads/UPLOAD_ID`)}
          node={`const upload = await vela.uploads.retrieve("UPLOAD_ID");
console.log(upload.status, upload.asset_id);`}
        />
      </Step>
    </>
  );
}

/* ------------------------------ Signed playback ------------------------------ */

function SignedPlayback() {
  const { v } = useDocs();
  const createBody = { input: "https://example.com/video.mp4", playback_policies: ["signed"] };
  return (
    <>
      <Step n={1} title="Create a signing key">
        <p>
          Signed playback IDs only play with a short-lived JWT that your server signs. Create a key on the <Link to="/signing-keys">Signing keys</Link> page or with the API. The response contains <code>id</code> and <code>private_key</code> (a base64-encoded PEM), which is shown only once: store it as a secret.
        </p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/signing-keys`)}
          node={`${nodeInit(v.api)}
const key = await vela.signingKeys.create();
// Save key.id as VELA_SIGNING_KEY_ID and key.private_key as VELA_SIGNING_PRIVATE_KEY.`}
        />
      </Step>

      <Step n={2} title="Use a signed playback ID">
        <p>
          Create the asset with <code>playback_policies: ["signed"]</code>, or add a signed playback ID to an existing asset.
        </p>
        <Sample
          curl={`${curlCmd("POST", `${v.api}/v1/assets`, createBody)}

# or add one to an existing asset
${curlCmd("POST", `${v.api}/v1/assets/${v.assetId}/playback-ids`, { policy: "signed" })}`}
          node={`const asset = await vela.assets.create(${js(createBody)});

// or add one to an existing asset
const playbackId = await vela.assets.createPlaybackId("${v.assetId}", "signed");`}
        />
      </Step>

      <Step n={3} title="Sign a token on your server">
        <p>
          <code>signPlaybackToken</code> falls back to the <code>VELA_SIGNING_KEY_ID</code> and <code>VELA_SIGNING_PRIVATE_KEY</code> environment variables. Never sign tokens in the browser.
        </p>
        <SignTokenSample />
        <p>Any JWT library works too. The token must be signed with RS256 and contain:</p>
        <div className="table-wrap">
          <table className="table doc-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>kid</code> (header)</td>
                <td>The signing key ID</td>
              </tr>
              <tr>
                <td><code>sub</code></td>
                <td>The playback ID</td>
              </tr>
              <tr>
                <td><code>aud</code></td>
                <td>
                  <code>v</code> video (also covers thumbnails, GIFs and storyboards), <code>t</code> thumbnail, <code>g</code> GIF, <code>s</code> storyboard, <code>d</code> DRM license
                </td>
              </tr>
              <tr>
                <td><code>exp</code></td>
                <td>Expiry (required)</td>
              </tr>
              <tr>
                <td><code>viewer_id</code></td>
                <td>Optional; your viewer's ID, available to DRM license requests as <code>{"{viewer_id}"}</code></td>
              </tr>
              <tr>
                <td><code>max_resolution</code></td>
                <td>Optional cap: <code>360p</code>, <code>480p</code>, <code>720p</code>, <code>1080p</code>, <code>1440p</code> or <code>2160p</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Step>

      <Step n={4} title="Play with the token">
        <p>Add the token as <code>?token=</code> to any playback URL, or pass it to the player:</p>
        <CodeBlock
          label="URLs"
          code={`${v.stream}/PLAYBACK_ID.m3u8?token=TOKEN
${v.stream}/PLAYBACK_ID/thumbnail.jpg?token=TOKEN
${v.stream}/embed/PLAYBACK_ID?token=TOKEN`}
        />
        <CodeBlock
          label="HTML"
          code={`<script src="${v.stream}/player.js" defer></script>
<vela-player playback-id="PLAYBACK_ID" token="TOKEN"></vela-player>`}
        />
        <p>
          To cut off access, revoke the signing key (<code>DELETE /v1/signing-keys/:id</code>, or on the <Link to="/signing-keys">Signing keys</Link> page): tokens it signed stop starting playback within seconds.
        </p>
      </Step>
    </>
  );
}

/* ------------------------------ Webhooks ------------------------------ */

const FALLBACK_EVENTS = [
  "video.asset.created",
  "video.asset.ready",
  "video.asset.errored",
  "video.asset.updated",
  "video.asset.deleted",
  "video.asset.static_renditions.ready",
  "video.asset.track.created",
  "video.asset.track.ready",
  "video.asset.track.errored",
  "video.asset.live_stream_completed",
  "video.upload.created",
  "video.upload.asset_created",
  "video.upload.cancelled",
  "video.upload.errored",
  "video.live_stream.created",
  "video.live_stream.connected",
  "video.live_stream.active",
  "video.live_stream.disconnected",
  "video.live_stream.idle",
  "video.live_stream.deleted",
  "video.live_stream.simulcast_target.broadcasting",
  "video.live_stream.simulcast_target.errored",
];

function Webhooks() {
  const { v } = useDocs();
  const types = useQuery({ queryKey: ["webhook-event-types"], queryFn: () => get<string[]>("/v1/webhooks/event-types"), staleTime: Infinity });
  const events = types.data ?? FALLBACK_EVENTS;
  const body = { url: "https://example.com/webhooks/vela", events: ["video.asset.ready", "video.asset.errored"] };
  const payload = {
    id: "EVENT_ID",
    type: "video.asset.ready",
    object: { type: "asset", id: v.assetId },
    environment: { id: v.envId },
    data: {
      id: v.assetId,
      status: "ready",
      title: v.title ?? "My first video",
      duration: v.duration ?? 42.5,
      playback_ids: [{ id: v.pid, policy: "public" }],
    },
    attempts: 1,
    created_at: "2026-01-01T12:00:00.000Z",
  };
  return (
    <>
      <Step n={1} title="Add an endpoint">
        <p>
          Add an endpoint on the <Link to="/webhooks">Webhooks</Link> page or with the API. Use <code>["*"]</code> to receive every event. The create response includes the endpoint's <code>secret</code>, which you need to verify signatures.
        </p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/webhooks`, body)}
          node={`${nodeInit(v.api)}
const endpoint = await vela.webhooks.create("${body.url}", ${js(body.events)});
// Save endpoint.secret as VELA_WEBHOOK_SECRET.`}
        />
      </Step>

      <Step n={2} title="What Vela sends">
        <p>
          Each event is a JSON <code>POST</code> with the headers <code>Vela-Signature</code>, <code>Vela-Event-Id</code> and <code>Vela-Event-Type</code>. <code>data</code> is the full object, the same as the API returns (here the asset from <code>GET /v1/assets/:id</code>, shortened).
        </p>
        <CodeBlock label="JSON" code={JSON.stringify(payload, null, 2)} />
        <p>
          Answer with any <code>2xx</code> within 15 seconds. Anything else (including redirects and timeouts) is retried with exponential backoff, up to 10 attempts; <code>attempts</code> counts them. Every delivery shows up in the endpoint's delivery log, where you can redeliver it.
        </p>
      </Step>

      <Step n={3} title="Verify the signature">
        <p>
          <code>Vela-Signature</code> looks like <code>t=1735732800,v1=5257a8…</code>: <code>v1</code> is the hex HMAC-SHA256 of <code>{"<t>.<raw body>"}</code> keyed with the endpoint secret. Verify it against the raw request body, before any JSON parsing, and reject old timestamps. <code>verifyWebhook</code> does both (tolerance 300 s by default):
        </p>
        <CodeBlock
          label="Node.js (Express)"
          code={`import express from "express";
import { verifyWebhook } from "@vela/node";

const app = express();

// express.raw keeps the exact bytes Vela signed.
app.post("/webhooks/vela", express.raw({ type: "application/json" }), (req, res) => {
  if (!verifyWebhook(req.body, req.get("Vela-Signature"), process.env.VELA_WEBHOOK_SECRET)) {
    return res.sendStatus(400);
  }
  const event = JSON.parse(req.body.toString());
  if (event.type === "video.asset.ready") {
    console.log("ready:", event.data.id, event.data.playback_ids);
  }
  res.sendStatus(200);
});`}
        />
      </Step>

      <Step n={4} title="Test and replay">
        <p>
          Use <strong>Send test event</strong> on the endpoint's page, or call the API. You can also list deliveries, redeliver one and rotate the secret.
        </p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/webhooks/WEBHOOK_ID/test`)}
          node={`// No helper for this one: vela.request is the SDK's generic, authenticated call.
await vela.request("POST", "/v1/webhooks/WEBHOOK_ID/test");`}
        />
        <div className="table-wrap">
          <table className="table doc-table">
            <tbody>
              <tr>
                <td><code>GET /v1/webhooks/:id/deliveries</code></td>
                <td>Delivery log with response status and body</td>
              </tr>
              <tr>
                <td><code>POST /v1/webhooks/deliveries/:did/redeliver</code></td>
                <td>Send a delivery again</td>
              </tr>
              <tr>
                <td><code>POST /v1/webhooks/:id/rotate-secret</code></td>
                <td>New signing secret</td>
              </tr>
              <tr>
                <td><code>GET /v1/webhooks/event-types</code></td>
                <td>Every event type</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Step>

      <Step title="Event types">
        <div className="doc-events">
          {events.map((e) => (
            <code key={e}>{e}</code>
          ))}
        </div>
      </Step>
    </>
  );
}

/* ------------------------------ Live ------------------------------ */

function Live() {
  const { v } = useDocs();
  const body = {
    playback_policies: ["public"],
    new_asset_settings: { playback_policies: ["public"] },
    latency_mode: "low",
    reconnect_window: 60,
    recording: true,
    title: "Weekly show",
  };
  const controls = [
    {
      name: "Reset stream key",
      call: "POST /v1/live-streams/:id/reset-stream-key",
      sdk: "resetStreamKey(id)",
      what: "The old key stops working immediately: a connected encoder is disconnected and can reconnect with the new key within the reconnect window (same session).",
    },
    {
      name: "Disable",
      call: "PUT /v1/live-streams/:id/disable",
      sdk: "disable(id)",
      what: "Refuses new connections, disconnects a connected encoder and ends the session (the recording is finalized).",
    },
    { name: "Enable", call: "PUT /v1/live-streams/:id/enable", sdk: "enable(id)", what: "Allows publishing again." },
    {
      name: "Complete",
      call: "PUT /v1/live-streams/:id/complete",
      sdk: "complete(id)",
      what: "Ends the session now instead of waiting for the reconnect window. A connected encoder is disconnected; if it reconnects, a new session (and recording) starts.",
    },
  ];
  return (
    <>
      <Step n={1} title="Create a live stream">
        <p>
          You can also create one on the <Link to="/live">Live streams</Link> page. <code>latency_mode</code> is <code>low</code> (default), <code>reduced</code> or <code>standard</code>; <code>reconnect_window</code> is how many seconds an encoder may drop out and still continue the same session (default 60); <code>new_asset_settings</code> apply to recordings.
        </p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/live-streams`, body)}
          node={`${nodeInit(v.api)}
const stream = await vela.liveStreams.create(${js(body)});
console.log(stream.ingest.rtmp.url, stream.stream_key, stream.playback_ids[0].id);`}
        />
        <p>The response includes the secret stream key and the ingest URLs:</p>
        <CodeBlock
          label="JSON"
          code={`"stream_key": "STREAM_KEY",
"ingest": {
  "rtmp": { "url": "rtmp://HOST:1935/live", "stream_key": "STREAM_KEY" },
  "rtmps": null,
  "srt": { "url": "srt://HOST:8890?streamid=publish:live/STREAM_KEY" }
}`}
        />
        <p className="small muted">
          <code>rtmps</code> is <code>{"{ url, stream_key }"}</code> when the server has RTMPS configured, otherwise <code>null</code>.
        </p>
      </Step>

      <Step n={2} title="Connect an encoder">
        <p>
          <strong>OBS:</strong> Settings → Stream → Service <em>Custom…</em>, Server = <code>ingest.rtmp.url</code>, Stream Key = <code>stream_key</code>. Under Output, set the keyframe interval to 2 s.
        </p>
        <p>
          <strong>ffmpeg</strong> (a test pattern, no camera needed):
        </p>
        <CodeBlock
          label="Shell"
          code={`ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine \\
  -c:v libx264 -preset veryfast -g 60 -c:a aac \\
  -f flv "rtmp://HOST:1935/live/STREAM_KEY"`}
        />
        <p>
          Encoders that speak SRT can publish to <code>ingest.srt.url</code> instead.
        </p>
      </Step>

      <Step n={3} title="Watch">
        <p>
          Live playback is low-latency HLS on the live stream's playback ID, with the same player and embed as on-demand video. Live streams accept <code>public</code> and <code>signed</code> playback policies.
        </p>
        <CodeBlock
          label="HTML"
          code={`<script src="${v.stream}/player.js" defer></script>
<vela-player playback-id="LIVE_PLAYBACK_ID"></vela-player>

<!-- or the HLS URL directly -->
${v.stream}/LIVE_PLAYBACK_ID.m3u8`}
        />
        <p>
          With <code>recording</code> on (the default), each session becomes an asset after the reconnect window passes; you get <code>video.asset.live_stream_completed</code> when the recording is ready. Live events (<code>video.live_stream.connected</code>, <code>active</code>, <code>disconnected</code>, <code>idle</code>) are listed under <Link to="/docs/webhooks">Webhooks</Link>.
        </p>
      </Step>

      <Step n={4} title="Control the stream">
        <div className="table-wrap">
          <table className="table doc-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Endpoint / SDK</th>
                <th>What happens</th>
              </tr>
            </thead>
            <tbody>
              {controls.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>
                    <code>{c.call}</code>
                    <br />
                    <code className="muted">vela.liveStreams.{c.sdk}</code>
                  </td>
                  <td>{c.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Sample curl={curlCmd("PUT", `${v.api}/v1/live-streams/LIVE_STREAM_ID/complete`)} node={`await vela.liveStreams.complete("LIVE_STREAM_ID");`} />
      </Step>
    </>
  );
}

/* ------------------------------ DRM ------------------------------ */

function Drm() {
  const { v } = useDocs();
  const body = { input: "https://example.com/video.mp4", playback_policies: ["drm"], title: "Premiere" };
  return (
    <>
      <Step n={1} title="Pick a license provider">
        <p>
          DRM videos are encrypted once (CENC) and play with Widevine, PlayReady and FairPlay. Licenses come from the provider set on the <Link to="/drm">DRM</Link> page:
        </p>
        <ul>
          <li>
            <strong>Built-in test mode</strong> uses W3C ClearKey. It needs no provider, but the keys reach the browser, so use it for development only.
          </li>
          <li>
            <strong>Multi-DRM provider</strong> (EZDRM, Axinom, DoveRunner/PallyCon, BuyDRM, …) for production.
          </li>
        </ul>
      </Step>

      <Step n={2} title="Create a DRM asset">
        <p>
          Use <code>playback_policies: ["drm"]</code>. MP4 downloads would be unencrypted copies, so <code>mp4_support</code> must stay <code>"none"</code>; anything else is refused with <code>400 invalid_parameters</code>. DRM is for on-demand assets; live streams ignore the <code>drm</code> policy.
        </p>
        <Sample
          curl={curlCmd("POST", `${v.api}/v1/assets`, body)}
          node={`${nodeInit(v.api)}
const asset = await vela.assets.create(${js(body)});`}
        />
      </Step>

      <Step n={3} title="Sign a playback token">
        <p>
          DRM playback IDs always need a signed token, made exactly like for <Link to="/docs/signed-playback">signed playback</Link>. Audience <code>v</code> covers playback and license requests; <code>d</code> covers license requests only.
        </p>
        <SignTokenSample />
      </Step>

      <Step n={4} title="Play">
        <p>
          <code>{"<vela-player>"}</code> (and the embed page) handle DRM automatically and request licenses with your token (or a separate <code>drm-token</code> attribute).
        </p>
        <CodeBlock
          label="HTML"
          code={`<script src="${v.stream}/player.js" defer></script>
<vela-player playback-id="PLAYBACK_ID" token="TOKEN"></vela-player>`}
        />
        <p>Bringing your own player? These are the endpoints it needs:</p>
        <CodeBlock
          label="Endpoints"
          code={`# Manifests
GET  ${v.stream}/PLAYBACK_ID.mpd?token=TOKEN    (DASH)
GET  ${v.stream}/PLAYBACK_ID.m3u8?token=TOKEN   (HLS)

# Licenses (the player's license request body, POSTed as is)
POST ${v.stream}/license/widevine/PLAYBACK_ID?token=TOKEN
POST ${v.stream}/license/playready/PLAYBACK_ID?token=TOKEN
POST ${v.stream}/license/fairplay/PLAYBACK_ID?token=TOKEN
POST ${v.stream}/license/clearkey/PLAYBACK_ID?token=TOKEN
GET  ${v.stream}/license/fairplay/PLAYBACK_ID/cert

# What the player needs (protection, DRM endpoints, tracks)
GET  ${v.stream}/PLAYBACK_ID/playback-info?token=TOKEN`}
        />
      </Step>
    </>
  );
}
