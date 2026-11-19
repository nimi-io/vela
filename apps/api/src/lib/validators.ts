import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "@vela/core";

/** http(s) URL; z.string().url() alone also accepts ftp:, file:, javascript:… */
export const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((s) => {
    try {
      return /^https?:$/.test(new URL(s).protocol);
    } catch {
      return false;
    }
  }, "must be an http:// or https:// URL");

const knownEvent = new Set<string>(["*", ...WEBHOOK_EVENT_TYPES]);
export const webhookEventList = z
  .array(z.string())
  .min(1)
  .superRefine((events, ctx) => {
    for (const e of events) {
      if (!knownEvent.has(e)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown event type "${e}" (see GET /v1/webhooks/event-types)` });
      }
    }
  });

/** YYYY-MM-DD that is a real calendar day. */
export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "must be a valid date");
