import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del, post } from "../lib/api";
import { useOne } from "../lib/hooks";
import { useSession } from "../lib/session";
import { relative } from "../lib/format";
import { PageHead, Panel, Empty, Modal, Field, CopyField, Code, Confirm, useToast, Loading } from "../components/ui";
import { IconPlus } from "../components/icons";

type ApiKey = { id: string; name: string; permissions: "full" | "read"; last_used_at: string | null; created_at: string };

export function ApiKeysPage() {
  const { env, config } = useSession();
  const keys = useOne<ApiKey[]>("api-keys", "/v1/api-keys");
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<(ApiKey & { secret: string }) | null>(null);
  const [revoke, setRevoke] = useState<ApiKey | null>(null);
  const [name, setName] = useState("Server");
  const [perm, setPerm] = useState<"full" | "read">("full");

  return (
    <div className="page">
      <PageHead
        title="API keys"
        description={`Access tokens for the ${env?.name} environment. Use them from your server with HTTP basic auth: the token ID is the username, the secret is the password.`}
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus /> New API key
          </button>
        }
      />
      <Panel flush>
        {keys.isLoading ? (
          <Loading />
        ) : !keys.data?.length ? (
          <Empty title="No API keys" action={<button className="btn primary" onClick={() => setCreating(true)}>Create an API key</button>}>
            Create a key to upload videos and manage live streams from your own backend.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Token ID</th>
                <th>Access</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td style={{ fontWeight: 550 }}>{k.name}</td>
                  <td className="mono">{k.id}</td>
                  <td>{k.permissions === "full" ? "Read and write" : "Read only"}</td>
                  <td className="small muted">{k.last_used_at ? relative(k.last_used_at) : "Never"}</td>
                  <td className="num">
                    <button className="btn ghost sm" onClick={() => setRevoke(k)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {creating && (
        <Modal
          title="New API key"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  const k = await post<ApiKey & { secret: string }>("/v1/api-keys", { name, permissions: perm });
                  setCreating(false);
                  setCreated(k);
                  qc.invalidateQueries({ queryKey: ["api-keys"] });
                }}
              >
                Create API key
              </button>
            </>
          }
        >
          <Field label="Name" hint="So you remember where it's used.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Access">
            <select className="input" value={perm} onChange={(e) => setPerm(e.target.value as any)}>
              <option value="full">Read and write</option>
              <option value="read">Read only</option>
            </select>
          </Field>
        </Modal>
      )}
      {created && (
        <Modal title="Save your secret now" description="This is the only time the secret is shown. Store it in your server's environment variables." onClose={() => setCreated(null)} wide footer={<button className="btn primary" onClick={() => setCreated(null)}>I've saved it</button>}>
          <Field label="Token ID">
            <CopyField value={created.id} label="Token ID" />
          </Field>
          <Field label="Secret">
            <CopyField value={created.secret} label="Secret" />
          </Field>
          <Code>{`curl ${config?.api_url}/v1/assets \\\n  -u ${created.id}:${created.secret}`}</Code>
        </Modal>
      )}
      {revoke && (
        <Confirm
          title={`Revoke "${revoke.name}"?`}
          body="Requests using this key will fail immediately."
          confirmLabel="Revoke key"
          danger
          onClose={() => setRevoke(null)}
          onConfirm={async () => {
            await del(`/v1/api-keys/${revoke.id}`);
            qc.invalidateQueries({ queryKey: ["api-keys"] });
          }}
        />
      )}
    </div>
  );
}

type SigningKey = { id: string; created_at: string };

export function SigningKeysPage() {
  const keys = useOne<SigningKey[]>("signing-keys", "/v1/signing-keys");
  const qc = useQueryClient();
  const toast = useToast();
  const [created, setCreated] = useState<(SigningKey & { private_key: string }) | null>(null);
  const [revoke, setRevoke] = useState<SigningKey | null>(null);
  const kid = created?.id ?? keys.data?.[0]?.id ?? "SIGNING_KEY_ID";

  const snippet = `// npm install jose
import { SignJWT, importPKCS8 } from "jose";

const privateKey = await importPKCS8(
  Buffer.from(process.env.VELA_SIGNING_PRIVATE_KEY, "base64").toString(),
  "RS256",
);

// aud: "v" video, "t" thumbnail, "s" storyboard, "g" gif, "d" DRM license
export async function playbackToken(playbackId, aud = "v") {
  return new SignJWT({ /* optional: viewer_id, max_resolution: "720p" */ })
    .setProtectedHeader({ alg: "RS256", kid: "${kid}" })
    .setSubject(playbackId)
    .setAudience(aud)
    .setExpirationTime("2h")
    .sign(privateKey);
}

// https://STREAM_URL/PLAYBACK_ID.m3u8?token=<token>`;

  return (
    <div className="page">
      <PageHead
        title="Signing keys"
        description="Your server signs short-lived tokens with these keys so only your viewers can watch signed and DRM videos."
        actions={
          <button
            className="btn primary"
            onClick={async () => {
              const k = await post<SigningKey & { private_key: string }>("/v1/signing-keys");
              setCreated(k);
              qc.invalidateQueries({ queryKey: ["signing-keys"] });
              toast("Signing key created");
            }}
          >
            <IconPlus /> New signing key
          </button>
        }
      />
      <div className="stack">
        <Panel flush>
          {keys.isLoading ? (
            <Loading />
          ) : !keys.data?.length ? (
            <Empty title="No signing keys">You need one before you can play signed or DRM videos outside the dashboard.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Key ID</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data.map((k) => (
                  <tr key={k.id}>
                    <td className="mono">{k.id}</td>
                    <td className="small muted">{relative(k.created_at)}</td>
                    <td className="num">
                      <button className="btn ghost sm" onClick={() => setRevoke(k)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Sign a playback token (Node.js)">
          <Code>{snippet}</Code>
        </Panel>
      </div>
      {created && (
        <Modal title="Save your private key now" description="It's shown once and never stored by Vela. Put it in VELA_SIGNING_PRIVATE_KEY on your server." wide onClose={() => setCreated(null)} footer={<button className="btn primary" onClick={() => setCreated(null)}>I've saved it</button>}>
          <Field label="Key ID">
            <CopyField value={created.id} label="Key ID" />
          </Field>
          <Field label="Private key (base64 PEM)">
            <CopyField value={created.private_key} label="Private key" />
          </Field>
        </Modal>
      )}
      {revoke && (
        <Confirm
          title="Revoke this signing key?"
          body="Tokens signed with it stop working within a minute."
          confirmLabel="Revoke key"
          danger
          onClose={() => setRevoke(null)}
          onConfirm={async () => {
            await del(`/v1/signing-keys/${revoke.id}`);
            qc.invalidateQueries({ queryKey: ["signing-keys"] });
          }}
        />
      )}
    </div>
  );
}
