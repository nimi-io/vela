import { Hono } from "hono";
import { z } from "zod";
import { getDb, organizations, memberships, environments, users, eq, and, sql } from "@vela/db";
import { randomId } from "@vela/core";
import { body, ok, notFound, ApiError } from "../lib/http.js";
import type { AppEnv } from "../types.js";

function requireAdmin(c: any) {
  const auth = c.get("auth");
  if (auth.kind !== "session" || auth.role === "member") {
    throw new ApiError(403, "forbidden", "Only owners and admins can do this");
  }
  return auth;
}

export const orgRoutes = new Hono<AppEnv>()
  .get("/org", async (c) => {
    const db = getDb();
    const { orgId } = c.get("auth");
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    const envs = await db.select().from(environments).where(eq(environments.orgId, orgId)).orderBy(environments.createdAt);
    const members = await db
      .select({ m: memberships, name: users.name })
      .from(memberships)
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(memberships.createdAt);
    return ok(c, {
      id: org!.id,
      name: org!.name,
      environments: envs.map((e) => ({ id: e.id, name: e.name, type: e.type, created_at: e.createdAt })),
      members: members.map((r) => ({
        id: r.m.id,
        email: r.m.email,
        name: r.name,
        role: r.m.role,
        status: r.m.status,
        created_at: r.m.createdAt,
      })),
    });
  })

  .patch("/org", async (c) => {
    const auth = requireAdmin(c);
    const input = await body(c, z.object({ name: z.string().min(1).max(200) }));
    await getDb().update(organizations).set({ name: input.name }).where(eq(organizations.id, auth.orgId));
    return ok(c, { id: auth.orgId, name: input.name });
  })

  .post("/environments", async (c) => {
    const auth = requireAdmin(c);
    const input = await body(
      c,
      z.object({ name: z.string().min(1).max(100), type: z.enum(["development", "production"]).default("development") }),
    );
    const [e] = await getDb()
      .insert(environments)
      .values({ id: randomId(24), orgId: auth.orgId, name: input.name, type: input.type })
      .returning();
    return ok(c, { id: e!.id, name: e!.name, type: e!.type }, 201);
  })

  .patch("/environments/:id", async (c) => {
    const auth = requireAdmin(c);
    const input = await body(c, z.object({ name: z.string().min(1).max(100) }));
    const res = await getDb()
      .update(environments)
      .set({ name: input.name })
      .where(and(eq(environments.id, c.req.param("id")), eq(environments.orgId, auth.orgId)))
      .returning();
    if (!res.length) notFound("Environment");
    return ok(c, { id: res[0]!.id, name: res[0]!.name, type: res[0]!.type });
  })

  .delete("/environments/:id", async (c) => {
    const auth = requireAdmin(c);
    const db = getDb();
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(environments)
      .where(eq(environments.orgId, auth.orgId))) as [{ n: number }];
    if (n <= 1) throw new ApiError(400, "invalid_request", "An organization needs at least one environment");
    const res = await db
      .delete(environments)
      .where(and(eq(environments.id, c.req.param("id")), eq(environments.orgId, auth.orgId)))
      .returning();
    if (!res.length) notFound("Environment");
    return c.body(null, 204);
  })

  .post("/members", async (c) => {
    const auth = requireAdmin(c);
    const input = await body(
      c,
      z.object({ email: z.string().email(), role: z.enum(["admin", "member"]).default("member") }),
    );
    const db = getDb();
    const email = input.email.toLowerCase();
    const [existingUser] = await db.select().from(users).where(eq(users.email, email));
    try {
      const [m] = await db
        .insert(memberships)
        .values({
          id: randomId(24),
          orgId: auth.orgId,
          email,
          role: input.role,
          userId: existingUser?.id,
          status: existingUser ? "active" : "invited",
        })
        .returning();
      return ok(c, { id: m!.id, email: m!.email, role: m!.role, status: m!.status }, 201);
    } catch {
      throw new ApiError(409, "already_member", "That email is already a member");
    }
  })

  .patch("/members/:id", async (c) => {
    const auth = requireAdmin(c);
    const input = await body(c, z.object({ role: z.enum(["owner", "admin", "member"]) }));
    const res = await getDb()
      .update(memberships)
      .set({ role: input.role })
      .where(and(eq(memberships.id, c.req.param("id")), eq(memberships.orgId, auth.orgId)))
      .returning();
    if (!res.length) notFound("Member");
    return ok(c, { id: res[0]!.id, role: res[0]!.role });
  })

  .delete("/members/:id", async (c) => {
    const auth = requireAdmin(c);
    const db = getDb();
    const [m] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, c.req.param("id")), eq(memberships.orgId, auth.orgId)));
    if (!m) notFound("Member");
    if (m.role === "owner") {
      const owners = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, auth.orgId), eq(memberships.role, "owner")));
      if (owners.length <= 1) throw new ApiError(400, "invalid_request", "Can't remove the last owner");
    }
    await db.delete(memberships).where(eq(memberships.id, m.id));
    return c.body(null, 204);
  });
