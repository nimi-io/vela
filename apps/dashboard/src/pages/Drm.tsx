import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { put } from "../lib/api";
import { useOne } from "../lib/hooks";
import { PageHead, Panel, Field, Segmented, useToast, Loading, CopyField } from "../components/ui";

type Drm = {
  provider: "clearkey" | "proxy";
  widevine_license_url?: string;
  playready_license_url?: string;
  fairplay_license_url?: string;
  fairplay_certificate_url?: string;
  license_headers?: Record<string, string>;
  key_registration_url?: string;
  key_registration_headers?: Record<string, string>;
  player_endpoints: Record<string, string>;
};

function HeaderEditor({ value, onChange }: { value: [string, string][]; onChange: (v: [string, string][]) => void }) {
  return (
    <div className="stack-sm">
      {value.map(([k, v], i) => (
        <div className="row" key={i}>
          <input className="input" style={{ flex: 1 }} placeholder="Header name" value={k} onChange={(e) => onChange(value.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
          <input className="input" style={{ flex: 2 }} placeholder="Value (supports {key_id}, {asset_id}, {viewer_id})" value={v} onChange={(e) => onChange(value.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
          <button type="button" className="btn ghost sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn sm" style={{ alignSelf: "flex-start" }} onClick={() => onChange([...value, ["", ""]])}>
        Add header
      </button>
    </div>
  );
}

export function DrmPage() {
  const q = useOne<Drm>("drm", "/v1/drm");
  const [d, setD] = useState<Drm | null>(null);
  const [lh, setLh] = useState<[string, string][]>([]);
  const [kh, setKh] = useState<[string, string][]>([]);
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    if (q.data) {
      setD(q.data);
      setLh(Object.entries(q.data.license_headers ?? {}));
      setKh(Object.entries(q.data.key_registration_headers ?? {}));
    }
  }, [q.data]);
  if (!d) return <Loading />;
  const set = (k: keyof Drm, v: string) => setD({ ...d, [k]: v });

  return (
    <div className="page">
      <PageHead
        title="DRM"
        description="Vela encrypts DRM videos once (CENC, cbcs) so they play with Widevine, PlayReady and FairPlay. Licenses come from the provider you connect here."
      />
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await put("/v1/drm", {
              provider: d.provider,
              widevine_license_url: d.widevine_license_url ?? "",
              playready_license_url: d.playready_license_url ?? "",
              fairplay_license_url: d.fairplay_license_url ?? "",
              fairplay_certificate_url: d.fairplay_certificate_url ?? "",
              license_headers: Object.fromEntries(lh.filter(([k]) => k)),
              key_registration_url: d.key_registration_url ?? "",
              key_registration_headers: Object.fromEntries(kh.filter(([k]) => k)),
            });
            qc.invalidateQueries({ queryKey: ["drm"] });
            toast("DRM settings saved");
          } catch (err: any) {
            toast(err.message, true);
          }
        }}
      >
        <Panel title="License provider">
          <div className="stack">
            <Segmented
              value={d.provider}
              onChange={(v) => setD({ ...d, provider: v })}
              options={[
                { value: "clearkey", label: "Built-in test mode" },
                { value: "proxy", label: "Multi-DRM provider" },
              ]}
            />
            {d.provider === "clearkey" ? (
              <div className="notice warn">
                Test mode uses W3C ClearKey: DRM videos play in Chrome, Edge and Firefox without any provider, but keys reach the browser. Use it to test, then connect a provider (EZDRM, Axinom, DoveRunner/PallyCon, BuyDRM, ...) before going to production.
              </div>
            ) : (
              <>
                <div className="grid-2">
                  <Field label="Widevine license URL">
                    <input className="input" value={d.widevine_license_url ?? ""} onChange={(e) => set("widevine_license_url", e.target.value)} placeholder="https://..." />
                  </Field>
                  <Field label="PlayReady license URL">
                    <input className="input" value={d.playready_license_url ?? ""} onChange={(e) => set("playready_license_url", e.target.value)} placeholder="https://..." />
                  </Field>
                  <Field label="FairPlay license URL">
                    <input className="input" value={d.fairplay_license_url ?? ""} onChange={(e) => set("fairplay_license_url", e.target.value)} placeholder="https://..." />
                  </Field>
                  <Field label="FairPlay certificate URL" hint="From Apple's FairPlay deployment package, usually hosted by your provider.">
                    <input className="input" value={d.fairplay_certificate_url ?? ""} onChange={(e) => set("fairplay_certificate_url", e.target.value)} placeholder="https://..." />
                  </Field>
                </div>
                <Field label="Headers sent with license requests" hint="Typically your provider's auth token. Saved values are masked.">
                  <HeaderEditor value={lh} onChange={setLh} />
                </Field>
              </>
            )}
          </div>
        </Panel>
        {d.provider === "proxy" && (
          <Panel title="Key delivery" description="When a DRM video is encoded, Vela can POST its content key to your provider so it can issue licenses.">
            <div className="stack">
              <Field label="Key registration URL" hint="Receives JSON: asset_id, key_id, key_id_uuid, key (hex), key_base64, iv.">
                <input className="input" value={d.key_registration_url ?? ""} onChange={(e) => set("key_registration_url", e.target.value)} placeholder="https://..." />
              </Field>
              <Field label="Headers">
                <HeaderEditor value={kh} onChange={setKh} />
              </Field>
            </div>
          </Panel>
        )}
        <Panel title="Player endpoints" description="The Vela player uses these automatically. Use them directly if you bring your own player.">
          <div className="stack-sm">
            {Object.entries(d.player_endpoints).map(([k, v]) => (
              <Field key={k} label={k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}>
                <CopyField value={v} />
              </Field>
            ))}
          </div>
        </Panel>
        <div>
          <button className="btn primary" type="submit">
            Save DRM settings
          </button>
        </div>
      </form>
    </div>
  );
}
