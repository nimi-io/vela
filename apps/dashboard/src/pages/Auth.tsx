import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { useSession } from "../lib/session";
import { Field } from "../components/ui";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { me, config } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [form, setForm] = useState({ email: "", password: "", name: "", organization_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (me) return <Navigate to={loc.state?.from ?? "/"} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await post(mode === "login" ? "/auth/login" : "/auth/signup", mode === "login" ? { email: form.email, password: form.password } : form);
      qc.setQueryData(["me"], data);
      nav(loc.state?.from ?? "/", { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="auth">
      <div className="auth-side">
        <div className="brand" style={{ color: "#fff" }}>
          <img src="/favicon.svg" alt="" />
          Vela
        </div>
        <div>
          <h1>Your video platform, on your own storage.</h1>
          <div className="strip" aria-hidden>
            {Array.from({ length: 24 }, (_, i) => (
              <span key={i} className={i === 13 ? "hot" : ""} />
            ))}
          </div>
          <p style={{ maxWidth: "46ch" }}>
            Upload, encode and stream video and live broadcasts with DRM, captions and viewer analytics. Files live in your own S3-compatible bucket.
          </p>
        </div>
        <p className="small" style={{ color: "#8b97a6" }}>
          Self-hosted. Your files, your keys.
        </p>
      </div>
      <div className="auth-form">
        <form onSubmit={submit}>
          <div>
            <h1>{mode === "login" ? "Sign in" : "Create your account"}</h1>
            <p className="muted" style={{ marginTop: 4 }}>
              {mode === "login" ? "Welcome back." : "You'll get a Development and a Production environment."}
            </p>
          </div>
          {mode === "signup" && (
            <>
              <Field label="Your name">
                <input className="input" value={form.name} onChange={set("name")} autoComplete="name" />
              </Field>
              <Field label="Team name">
                <input className="input" value={form.organization_name} onChange={set("organization_name")} placeholder="Acme Video" />
              </Field>
            </>
          )}
          <Field label="Email">
            <input className="input" type="email" required value={form.email} onChange={set("email")} autoComplete="email" />
          </Field>
          <Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
            <input className="input" type="password" required minLength={mode === "signup" ? 8 : undefined} value={form.password} onChange={set("password")} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </Field>
          {error && <div className="notice bad">{error}</div>}
          <button className="btn primary" disabled={busy} type="submit">
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
          {mode === "login" ? (
            config?.signups_enabled !== false && (
              <p className="small muted">
                New here? <Link to="/signup">Create an account</Link>
              </p>
            )
          ) : (
            <p className="small muted">
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
