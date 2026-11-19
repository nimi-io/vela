import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { del, patch, post } from "../lib/api";
import { useOne } from "../lib/hooks";
import { useSession } from "../lib/session";
import { relative } from "../lib/format";
import { PageHead, Panel, Field, Confirm, useToast } from "../components/ui";

type OrgData = {
  id: string;
  name: string;
  environments: { id: string; name: string; type: string; created_at: string }[];
  members: { id: string; email: string; name: string | null; role: string; status: string; created_at: string }[];
};

export function SettingsPage() {
  const { org: sessOrg, me, refresh } = useSession();
  const q = useOne<OrgData>("org", "/v1/org");
  const qc = useQueryClient();
  const toast = useToast();
  const [orgName, setOrgName] = useState<string | null>(null);
  const [envName, setEnvName] = useState("");
  const [envType, setEnvType] = useState("development");
  const [invite, setInvite] = useState("");
  const [role, setRole] = useState("member");
  const [removeEnv, setRemoveEnv] = useState<string | null>(null);
  const [name, setName] = useState(me?.user.name ?? "");
  const [pw, setPw] = useState({ current: "", next: "" });
  const isAdmin = sessOrg?.role !== "member";
  const org = q.data;
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: ["org"] });
    await refresh();
  };
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await reload();
      toast(msg);
    } catch (err: any) {
      toast(err.message, true);
    }
  };

  return (
    <div className="page">
      <PageHead title="Settings" />
      <div className="stack">
        <Panel title="Team">
          <form className="row" onSubmit={(e) => (e.preventDefault(), run(() => patch("/v1/org", { name: orgName }), "Team name saved"))}>
            <input className="input" style={{ maxWidth: 360 }} value={orgName ?? org?.name ?? ""} onChange={(e) => setOrgName(e.target.value)} disabled={!isAdmin} aria-label="Team name" />
            {isAdmin && <button className="btn">Save name</button>}
          </form>
        </Panel>

        <Panel flush title="Environments" description="Each environment has its own videos, keys, webhooks and settings. Keep tests out of production.">
          <table className="table">
            <tbody>
              {org?.environments.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontWeight: 550 }}>{e.name}</td>
                  <td className="small" style={{ textTransform: "capitalize" }}>
                    {e.type}
                  </td>
                  <td className="mono small muted">{e.id}</td>
                  <td className="num">
                    {isAdmin && (org.environments.length > 1) && (
                      <button className="btn ghost sm" onClick={() => setRemoveEnv(e.id)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && (
            <form
              className="row panel-body"
              style={{ borderTop: "1px solid var(--line-2)" }}
              onSubmit={(e) => {
                e.preventDefault();
                run(() => post("/v1/environments", { name: envName, type: envType }), "Environment added").then(() => setEnvName(""));
              }}
            >
              <input className="input" style={{ maxWidth: 240 }} placeholder="Staging" value={envName} onChange={(e) => setEnvName(e.target.value)} required aria-label="New environment name" />
              <select className="input" style={{ width: 160 }} value={envType} onChange={(e) => setEnvType(e.target.value)} aria-label="Type">
                <option value="development">Development</option>
                <option value="production">Production</option>
              </select>
              <button className="btn">Add environment</button>
            </form>
          )}
        </Panel>

        <Panel flush title="Members">
          <table className="table">
            <tbody>
              {org?.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{m.name || m.email}</div>
                    {m.name && <div className="small muted">{m.email}</div>}
                  </td>
                  <td>
                    {isAdmin ? (
                      <select className="input" style={{ width: 130 }} value={m.role} onChange={(e) => run(() => patch(`/v1/members/${m.id}`, { role: e.target.value }), "Role updated")} aria-label="Role">
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </select>
                    ) : (
                      <span style={{ textTransform: "capitalize" }}>{m.role}</span>
                    )}
                  </td>
                  <td className="small">{m.status === "invited" ? <span className="badge warn">Invited, not signed up yet</span> : `Joined ${relative(m.created_at)}`}</td>
                  <td className="num">
                    {isAdmin && m.email !== me?.user.email && (
                      <button className="btn ghost sm" onClick={() => run(() => del(`/v1/members/${m.id}`), "Member removed")}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin && (
            <form
              className="row panel-body"
              style={{ borderTop: "1px solid var(--line-2)" }}
              onSubmit={(e) => {
                e.preventDefault();
                run(() => post("/v1/members", { email: invite, role }), "Invitation added. They can now sign up with that email.").then(() => setInvite(""));
              }}
            >
              <input className="input" type="email" style={{ maxWidth: 280 }} placeholder="teammate@example.com" value={invite} onChange={(e) => setInvite(e.target.value)} required aria-label="Email to invite" />
              <select className="input" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button className="btn">Invite</button>
            </form>
          )}
        </Panel>

        <Panel title="Your account">
          <div className="grid-2">
            <form className="stack-sm" onSubmit={(e) => (e.preventDefault(), run(() => patch("/auth/me", { name }), "Name saved"))}>
              <Field label="Name">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <button className="btn" style={{ alignSelf: "flex-start" }}>
                Save name
              </button>
            </form>
            <form
              className="stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => patch("/auth/me", { current_password: pw.current, new_password: pw.next }), "Password changed").then(() => setPw({ current: "", next: "" }));
              }}
            >
              <Field label="Current password">
                <input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
              </Field>
              <Field label="New password" hint="At least 8 characters.">
                <input className="input" type="password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
              </Field>
              <button className="btn" style={{ alignSelf: "flex-start" }} disabled={!pw.current || pw.next.length < 8}>
                Change password
              </button>
            </form>
          </div>
        </Panel>
      </div>
      {removeEnv && (
        <Confirm
          title="Delete this environment?"
          body="All of its videos, live streams, keys and webhooks are deleted. This can't be undone."
          confirmLabel="Delete environment"
          danger
          onClose={() => setRemoveEnv(null)}
          onConfirm={() => run(() => del(`/v1/environments/${removeEnv}`), "Environment deleted")}
        />
      )}
    </div>
  );
}
