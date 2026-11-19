import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../lib/api";
import { useList, useOne } from "../lib/hooks";
import { dateTime, relative } from "../lib/format";
import { PageHead, Panel, Empty, Modal, Field, CopyField, Code, Confirm, StatusBadge, useToast, Loading } from "../components/ui";
import { IconPlus } from "../components/icons";

type Endpoint = { id: string; url: string; events: string[]; enabled: boolean; secret: string; created_at: string };

export function WebhooksPage() {
  const list = useOne<Endpoint[]>("webhooks", "/v1/webhooks");
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  return (
    <div className="page">
      <PageHead
        title="Webhooks"
        description="Get an HTTP POST when a video is ready, a live stream starts, an upload finishes and more. Failed deliveries are retried with backoff."
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus /> Add endpoint
          </button>
        }
      />
      <div className="stack">
        <Panel flush>
          {list.isLoading ? (
            <Loading />
          ) : !list.data?.length ? (
            <Empty title="No endpoints" action={<button className="btn primary" onClick={() => setCreating(true)}>Add an endpoint</button>}>
              Add your server's URL to be told when videos finish processing.
            </Empty>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Events</th>
                  <th>Status</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((w) => (
                  <tr key={w.id} className="click" onClick={() => nav(`/webhooks/${w.id}`)}>
                    <td className="mono">{w.url}</td>
                    <td className="small">{w.events.includes("*") ? "All events" : `${w.events.length} events`}</td>
                    <td>{w.enabled ? <span className="badge ok">Enabled</span> : <span className="badge">Paused</span>}</td>
                    <td className="small muted">{relative(w.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Panel>
        <EventLog />
      </div>
      {creating && <EndpointModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function EventLog() {
  const [page, setPage] = useState(1);
  const list = useList<any>("events", `/v1/events?limit=15&page=${page}`);
  const [open, setOpen] = useState<any>(null);
  return (
    <Panel flush title="Recent events" description="Everything that happened in this environment, delivered or not.">
      {!list.data?.data.length ? (
        <div className="panel-body muted">No events yet.</div>
      ) : (
        <div className="table-wrap"><table className="table">
          <tbody>
            {list.data.data.map((e) => (
              <tr key={e.id} className="click" onClick={() => setOpen(e)}>
                <td className="mono">{e.type}</td>
                <td className="mono muted small">{e.object?.id}</td>
                <td className="small muted num">{relative(e.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      <div className="pager">
        <span>Page {page}</span>
        <div className="row">
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <button className="btn sm" disabled={(list.data?.data.length ?? 0) < 15} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      </div>
      {open && (
        <Modal title={open.type} description={dateTime(open.created_at)} wide onClose={() => setOpen(null)}>
          <Code>{JSON.stringify(open.data, null, 2)}</Code>
        </Modal>
      )}
    </Panel>
  );
}

function EndpointModal({ onClose, existing }: { onClose: () => void; existing?: Endpoint }) {
  const types = useOne<string[]>("event-types", "/v1/webhooks/event-types");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [all, setAll] = useState(existing ? existing.events.includes("*") : true);
  const [events, setEvents] = useState<string[]>(existing && !existing.events.includes("*") ? existing.events : []);
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  return (
    <Modal
      title={existing ? "Edit endpoint" : "Add endpoint"}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!url || (!all && !events.length)}
            onClick={async () => {
              try {
                const body = { url, events: all ? ["*"] : events };
                if (existing) await patch(`/v1/webhooks/${existing.id}`, body);
                else {
                  const w = await post<Endpoint>("/v1/webhooks", body);
                  nav(`/webhooks/${w.id}`);
                }
                qc.invalidateQueries({ queryKey: ["webhooks"] });
                qc.invalidateQueries({ queryKey: ["webhook"] });
                onClose();
              } catch (err: any) {
                toast(err.message, true);
              }
            }}
          >
            {existing ? "Save endpoint" : "Add endpoint"}
          </button>
        </>
      }
    >
      <Field label="Endpoint URL">
        <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/webhooks/vela" />
      </Field>
      <label className="check">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Send every event
      </label>
      {!all && (
        <div className="grid-2" style={{ gap: 6 }}>
          {(types.data ?? []).map((t) => (
            <label key={t} className="check small">
              <input type="checkbox" checked={events.includes(t)} onChange={(e) => setEvents(e.target.checked ? [...events, t] : events.filter((x) => x !== t))} />
              <span className="mono">{t}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function WebhookPage() {
  const { id } = useParams();
  const w = useOne<Endpoint>("webhook", `/v1/webhooks/${id}`);
  const deliveries = useList<any>("deliveries", `/v1/webhooks/${id}/deliveries?limit=30`, { refetch: () => 5000 });
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState<any>(null);
  if (w.isLoading) return <Loading />;
  if (!w.data) return <div className="page">Endpoint not found.</div>;
  const ep = w.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["webhook"] });

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack-sm">
          <Link to="/webhooks" className="small">
            Webhooks
          </Link>
          <h1 className="mono" style={{ fontSize: 18 }}>
            {ep.url}
          </h1>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              await post(`/v1/webhooks/${ep.id}/test`);
              toast("Test event sent");
              qc.invalidateQueries({ queryKey: ["deliveries"] });
            }}
          >
            Send test event
          </button>
          <button className="btn" onClick={() => setEdit(true)}>
            Edit
          </button>
          <button className="btn" onClick={async () => (await patch(`/v1/webhooks/${ep.id}`, { enabled: !ep.enabled }), refresh())}>
            {ep.enabled ? "Pause" : "Resume"}
          </button>
        </div>
      </div>
      <div className="split">
        <Panel flush title="Deliveries">
          {!deliveries.data?.data.length ? (
            <div className="panel-body muted">No deliveries yet. Send a test event to try it.</div>
          ) : (
            <div className="table-wrap"><table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Result</th>
                  <th>Attempts</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.data.map((d) => (
                  <tr key={d.id} className="click" onClick={() => setOpen(d)}>
                    <td className="mono">{d.event.type}</td>
                    <td>
                      <div className="row">
                        <StatusBadge status={d.status} />
                        {d.response_status && <span className="small muted">HTTP {d.response_status}</span>}
                      </div>
                    </td>
                    <td className="small">{d.attempts}</td>
                    <td className="small muted">{relative(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Panel>
        <div className="stack">
          <Panel title="Signing secret" description="Verify the Vela-Signature header with this secret.">
            <div className="stack-sm">
              <CopyField value={ep.secret} label="Secret" />
              <button className="btn sm" style={{ alignSelf: "flex-start" }} onClick={async () => (await post(`/v1/webhooks/${ep.id}/rotate-secret`), refresh(), toast("Secret rotated"))}>
                Rotate secret
              </button>
            </div>
          </Panel>
          <Panel title="Verify a delivery (Node.js)">
            <Code>{`import crypto from "node:crypto";

// header: Vela-Signature: t=<unix>,v1=<hex>
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(
    header.split(",").map((p) => p.split("=")),
  );
  const expected = crypto
    .createHmac("sha256", secret)
    .update(\`\${t}.\${rawBody}\`)
    .digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && crypto.timingSafeEqual(
    Buffer.from(expected), Buffer.from(v1),
  );
}`}</Code>
          </Panel>
          <Panel title="Danger zone">
            <button className="btn danger" onClick={() => setConfirm(true)}>
              Delete endpoint
            </button>
          </Panel>
        </div>
      </div>
      {edit && <EndpointModal existing={ep} onClose={() => setEdit(false)} />}
      {open && (
        <Modal
          title={open.event.type}
          description={`${dateTime(open.created_at)}, ${open.attempts} attempt${open.attempts === 1 ? "" : "s"}`}
          wide
          onClose={() => setOpen(null)}
          footer={
            <button
              className="btn"
              onClick={async () => {
                await post(`/v1/webhooks/deliveries/${open.id}/redeliver`);
                toast("Redelivery queued");
                setOpen(null);
              }}
            >
              Redeliver
            </button>
          }
        >
          <h3>Payload</h3>
          <Code>{JSON.stringify(open.event.data, null, 2)}</Code>
          <h3>Response{open.response_status ? ` (HTTP ${open.response_status})` : ""}</h3>
          <Code>{open.response_body || "(empty)"}</Code>
        </Modal>
      )}
      {confirm && (
        <Confirm
          title="Delete this endpoint?"
          body="No more events will be sent to it."
          confirmLabel="Delete endpoint"
          danger
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await del(`/v1/webhooks/${ep.id}`);
            nav("/webhooks");
          }}
        />
      )}
    </div>
  );
}
