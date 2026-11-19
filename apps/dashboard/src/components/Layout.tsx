import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "../lib/session";
import { api } from "../lib/api";
import { IconHome, IconVideo, IconLive, IconChart, IconHook, IconKey, IconSign, IconShield, IconGauge, IconSettings, IconMenu, IconLogout } from "./icons";

const groups = [
  {
    items: [
      { to: "/", label: "Overview", icon: IconHome, end: true },
      { to: "/videos", label: "Videos", icon: IconVideo },
      { to: "/live", label: "Live streams", icon: IconLive },
      { to: "/analytics", label: "Analytics", icon: IconChart },
    ],
  },
  {
    label: "Developers",
    items: [
      { to: "/api-keys", label: "API keys", icon: IconKey },
      { to: "/signing-keys", label: "Signing keys", icon: IconSign },
      { to: "/webhooks", label: "Webhooks", icon: IconHook },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/drm", label: "DRM", icon: IconShield },
      { to: "/usage", label: "Usage", icon: IconGauge },
      { to: "/settings", label: "Settings", icon: IconSettings },
    ],
  },
];

export function Layout() {
  const { me, org, env, setEnv } = useSession();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();

  return (
    <div className="shell">
      <aside className={`sidebar${open ? " open" : ""}`} onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          Vela
        </div>
        <label className="field">
          <span className="small muted">Environment</span>
          <select className="input" value={env?.id ?? ""} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
            {me?.organizations.map((o) => (
              <optgroup key={o.id} label={o.name}>
                {o.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <nav className="nav">
          {groups.map((g, i) => (
            <div key={i} className="stack-sm" style={{ gap: 1 }}>
              {g.label && <div className="nav-group">{g.label}</div>}
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={"end" in it ? it.end : false}>
                  <it.icon />
                  {it.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="small">
            <div style={{ fontWeight: 550 }}>{me?.user.name || me?.user.email}</div>
            <div className="muted">{org?.name}</div>
          </div>
          <button
            className="btn ghost sm"
            style={{ justifyContent: "flex-start" }}
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              qc.setQueryData(["me"], null);
              nav("/login");
            }}
          >
            <IconLogout /> Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <div className="mobile-bar">
          <button className="btn ghost sm" aria-label="Open menu" onClick={() => setOpen(true)}>
            <IconMenu />
          </button>
          <strong>Vela</strong>
          <span className="muted small right">{env?.name}</span>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
