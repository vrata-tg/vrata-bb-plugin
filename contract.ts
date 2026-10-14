import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const credentialsContract = defineRpcContract({
  sync: {
    input: z.object({ apiKey: z.string(), baseUrl: z.string().url() }).strict(),
    output: z.object({ configured: z.boolean() }).strict(),
  },
});

export const setupContract = defineRpcContract({
  validateKey: {
    input: z.object({ apiKey: z.string().trim().min(1).max(4096) }).strict(),
    output: z.object({ valid: z.literal(true) }).strict(),
  },
  waitForKey: {
    input: z.null(),
    output: z.object({ configured: z.literal(true) }).strict(),
  },
});

export const DEFAULT_BASE_URL = "https://api.vrata.tg";
