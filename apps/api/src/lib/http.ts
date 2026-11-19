import type { Context } from "hono";
import { z, type ZodTypeAny } from "zod";
import { ApiError } from "@vela/core";

export { ApiError };

export async function body<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_parameters",
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

export function pagination(c: Context) {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25) || 25, 1), 100);
  const page = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

export function notFound(what = "Resource"): never {
  throw new ApiError(404, "not_found", `${what} not found`);
}

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ data }, status);
}

/**
 * Drops undefined fields from a PATCH payload. Callers skip the UPDATE when nothing is left:
 * an empty `.set({})` makes drizzle throw ("No values to set"), which surfaced as a 500.
 */
export function changes<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const hasChanges = (patch: Record<string, unknown>) => Object.keys(patch).length > 0;
