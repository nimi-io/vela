import { Hono } from "hono";
import { z } from "zod";
import { getDb, apiKeys, signingKeys, eq, and, desc, isNull } from "@vela/db";
import { randomId, randomSecret, sha256, generateRsaKeyPair, apiKeyJson, signingKeyJson, publishInvalidation } from "@vela/core";
import { body, ok, notFound } from "../lib/http.js";
import { sessionOnly } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

export const apiKeyRoutes = new Hono<AppEnv>()
  .use(sessionOnly)
  .get("/", async (c) => {
    const rows = await getDb()
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.environmentId, c.get("environmentId")), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
    return ok(c, rows.map(apiKeyJson));
  })
  .post("/", async (c) => {
    const input = await body(
      c,
      z.object({ name: z.string().min(1).max(100).default("API key"), permissions: z.enum(["full", "read"]).default("full") }),
    );
    const id = randomId(32);
    const secret = randomSecret(36);
    const [k] = await getDb()
      .insert(apiKeys)
      .values({ id, environmentId: c.get("environmentId"), name: input.name, permissions: input.permissions, secretHash: sha256(secret) })
      .returning();
    // The secret is only ever shown once.
    return ok(c, { ...apiKeyJson(k!), secret }, 201);
  })
  .delete("/:id", async (c) => {
    const res = await getDb()
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.environmentId, c.get("environmentId"))))
      .returning();
    if (!res.length) notFound("API key");
    return c.body(null, 204);
  });

/** RSA keys your backend uses to sign playback JWTs for signed/DRM playback IDs. */
export const signingKeyRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const rows = await getDb()
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.environmentId, c.get("environmentId")), isNull(signingKeys.revokedAt)))
      .orderBy(desc(signingKeys.createdAt));
    return ok(c, rows.map(signingKeyJson));
  })
  .post("/", async (c) => {
    const { publicKey, privateKey } = generateRsaKeyPair();
    const [k] = await getDb()
      .insert(signingKeys)
      .values({ id: randomId(24), environmentId: c.get("environmentId"), publicKey })
      .returning();
    // Private key is returned once (base64 PEM, like Mux) and never stored.
    return ok(c, { ...signingKeyJson(k!), private_key: Buffer.from(privateKey).toString("base64") }, 201);
  })
  .get("/:id", async (c) => {
    const [k] = await getDb()
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.id, c.req.param("id")), eq(signingKeys.environmentId, c.get("environmentId"))));
    if (!k) notFound("Signing key");
    return ok(c, { ...signingKeyJson(k), public_key: k.publicKey });
  })
  .delete("/:id", async (c) => {
    const res = await getDb()
      .update(signingKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(signingKeys.id, c.req.param("id")), eq(signingKeys.environmentId, c.get("environmentId"))))
      .returning();
    if (!res.length) notFound("Signing key");
    await publishInvalidation({ signingKeys: res.map((k) => `${k.environmentId}:${k.id}`) });
    return c.body(null, 204);
  });
