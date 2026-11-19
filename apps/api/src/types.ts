export type AuthInfo =
  | { kind: "session"; userId: string; orgId: string; role: "owner" | "admin" | "member" }
  | { kind: "key"; keyId: string; orgId: string; permissions: "full" | "read" };

export type AppEnv = {
  Variables: {
    auth: AuthInfo;
    environmentId: string;
    userId?: string;
    requestId: string;
  };
};
