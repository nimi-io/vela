import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import {
  getDb,
  users,
  sessions,
  organizations,
  memberships,
  environments,
  eq,
  and,
  sql,
} from "@vela/db";
import { env, randomId, randomSecret, sha256 } from "@vela/core";
import { body, ApiError } from "../lib/http.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { SESSION_COOKIE, sessionUser } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const SESSION_DAYS = 30;

async function startSession(c: any, userId: string) {
  const token = randomSecret(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await getDb().insert(sessions).values({ id: sha256(token), userId, expiresAt });
  const e = env();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: e.SESSION_COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    domain: e.SESSION_COOKIE_DOMAIN || undefined,
    expires: expiresAt,
  });
}

export async function userContext(userId: string) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const rows = await db
    .select({ org: organizations, m: memberships })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")));
  const orgs = [];
  for (const r of rows) {
    const envs = await db.select().from(environments).where(eq(environments.orgId, r.org.id)).orderBy(environments.createdAt);
    orgs.push({
      id: r.org.id,
      name: r.org.name,
      role: r.m.role,
      environments: envs.map((e) => ({ id: e.id, name: e.name, type: e.type })),
    });
  }
  return { user: { id: user!.id, email: user!.email, name: user!.name }, organizations: orgs };
}

export const authRoutes = new Hono<AppEnv>()
  .post("/signup", async (c) => {
    const input = await body(
      c,
      z.object({
        email: z.string().email().max(255),
        password: z.string().min(8).max(200),
        name: z.string().max(200).optional(),
        organization_name: z.string().max(200).optional(),
      }),
    );
    const db = getDb();
    const email = input.email.toLowerCase();

    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(users)) as [{ n: number }];
    const pendingInvites = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.email, email), eq(memberships.status, "invited")));
    // The first user can always sign up; later users need SIGNUPS_ENABLED or an invite.
    if (n > 0 && !env().SIGNUPS_ENABLED && pendingInvites.length === 0) {
      throw new ApiError(403, "signups_disabled", "Sign-ups are disabled on this instance");
    }
    const [existing] = await db.select().from(users).where(eq(users.email, email));
    if (existing) throw new ApiError(409, "email_taken", "An account with this email already exists");

    const userId = randomId(24);
    await db.insert(users).values({
      id: userId,
      email,
      name: input.name ?? "",
      passwordHash: await hashPassword(input.password),
    });

    if (pendingInvites.length) {
      await db
        .update(memberships)
        .set({ userId, status: "active" })
        .where(and(eq(memberships.email, email), eq(memberships.status, "invited")));
    } else {
      const orgId = randomId(24);
      await db.insert(organizations).values({ id: orgId, name: input.organization_name ?? `${input.name || email.split("@")[0]}'s team` });
      await db.insert(memberships).values({ id: randomId(24), orgId, userId, email, role: "owner", status: "active" });
      await db.insert(environments).values([
        { id: randomId(24), orgId, name: "Development", type: "development" },
        { id: randomId(24), orgId, name: "Production", type: "production" },
      ]);
    }

    await startSession(c, userId);
    return c.json({ data: await userContext(userId) }, 201);
  })

  .post("/login", async (c) => {
    const input = await body(c, z.object({ email: z.string().email(), password: z.string() }));
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase()));
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new ApiError(401, "invalid_credentials", "Email or password is incorrect");
    }
    await startSession(c, user.id);
    return c.json({ data: await userContext(user.id) });
  })

  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await getDb().delete(sessions).where(eq(sessions.id, sha256(token)));
    deleteCookie(c, SESSION_COOKIE, { path: "/", domain: env().SESSION_COOKIE_DOMAIN || undefined });
    return c.json({ data: { ok: true } });
  })

  .get("/me", async (c) => {
    const user = await sessionUser(c);
    if (!user) throw new ApiError(401, "unauthorized", "Not signed in");
    return c.json({ data: await userContext(user.id) });
  })

  .patch("/me", async (c) => {
    const user = await sessionUser(c);
    if (!user) throw new ApiError(401, "unauthorized", "Not signed in");
    const input = await body(
      c,
      z.object({
        name: z.string().max(200).optional(),
        current_password: z.string().optional(),
        new_password: z.string().min(8).max(200).optional(),
      }),
    );
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.new_password) {
      if (!input.current_password || !(await verifyPassword(input.current_password, user.passwordHash))) {
        throw new ApiError(400, "invalid_credentials", "Current password is incorrect");
      }
      patch.passwordHash = await hashPassword(input.new_password);
    }
    if (Object.keys(patch).length) await getDb().update(users).set(patch).where(eq(users.id, user.id));
    return c.json({ data: await userContext(user.id) });
  })

  .get("/config", (c) => {
    const e = env();
    return c.json({
      data: {
        signups_enabled: e.SIGNUPS_ENABLED,
        stream_url: e.STREAM_PUBLIC_URL,
        api_url: e.API_PUBLIC_URL,
        transcription_enabled: e.TRANSCRIPTION_PROVIDER !== "none",
        llm_enabled: !!e.OPENAI_API_KEY || !!(e.CLOUDFLARE_ACCOUNT_ID && e.CLOUDFLARE_API_TOKEN),
      },
    });
  });
