import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { balanceResultSchema } from "./balance.js";

export const accountContract = defineRpcContract({
  balance: { input: z.null(), output: balanceResultSchema },
});

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
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ configured: z.literal(true) }).strict(),
  },
});

export const DEFAULT_BASE_URL = "https://api.vrata.tg";
