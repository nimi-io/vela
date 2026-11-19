import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, setEnvironment, setUnauthorizedHandler } from "./api";

export type Env = { id: string; name: string; type: "development" | "production" };
export type Org = { id: string; name: string; role: "owner" | "admin" | "member"; environments: Env[] };
export type Me = { user: { id: string; email: string; name: string }; organizations: Org[] };
export type Config = { signups_enabled: boolean; stream_url: string; api_url: string; transcription_enabled: boolean; llm_enabled: boolean };

type Session = {
  me: Me | null;
  config: Config | null;
  org: Org | null;
  env: Env | null;
  setEnv: (id: string) => void;
  loading: boolean;
  refresh: () => Promise<void>;
};

const Ctx = createContext<Session>(null as any);
const ENV_KEY = "vela_env";

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: () => get<Config>("/auth/config"), staleTime: Infinity });
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/auth/me"), retry: false, staleTime: 60_000 });
  const [envId, setEnvId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ENV_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    setUnauthorizedHandler(() => qc.setQueryData(["me"], null));
  }, [qc]);

  const { org, env } = useMemo(() => {
    const orgs = me.data?.organizations ?? [];
    for (const o of orgs) {
      const e = o.environments.find((x) => x.id === envId);
      if (e) return { org: o, env: e };
    }
    const o = orgs[0] ?? null;
    return { org: o, env: o?.environments[0] ?? null };
  }, [me.data, envId]);

  // Keep the API client in sync before any child query runs.
  setEnvironment(env?.id ?? null);

  const value: Session = {
    me: me.data ?? null,
    config: config.data ?? null,
    org,
    env,
    loading: me.isLoading || config.isLoading,
    setEnv: (id) => {
      try {
        localStorage.setItem(ENV_KEY, id);
      } catch {}
      setEnvironment(id);
      setEnvId(id);
      qc.removeQueries({ predicate: (q) => !["me", "config"].includes(String(q.queryKey[0])) });
    },
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
