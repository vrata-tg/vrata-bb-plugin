import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { balanceResultSchema } from "./balance.js";

export const DEFAULT_BASE_URL = "https://api.vrata.tg";

const hostId = z.string().min(1);
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("host"), hostId }).strict(),
]);
export type ConfigurationTarget = z.infer<typeof target>;

const credentials = z.object({ apiKey: z.string().min(1).max(4096), baseUrl: z.string().url() }).strict();
const localConfiguration = z.object({ configured: z.boolean(), baseUrl: z.string().url() }).strict();
const configuration = localConfiguration.extend({ hostId, hostName: z.string() });

export const configurationContract = defineRpcContract({
  listHosts: {
    input: z.null(),
    output: z.array(z.object({ id: hostId, name: z.string(), status: z.enum(["connected", "disconnected"]) }).strict()),
  },
  getConfiguration: { input: z.object({ target }).strict(), output: configuration },
  saveCredentials: { input: credentials.extend({ target }), output: configuration },
  deleteCredentials: { input: z.object({ hostId }).strict(), output: configuration },
});

export const accountContract = defineRpcContract({
  balance: { input: z.object({ hostId }).strict(), output: balanceResultSchema },
});

export const credentialsContract = defineRpcContract({
  getConfiguration: { input: z.null(), output: localConfiguration },
  saveCredentials: { input: credentials, output: localConfiguration },
  deleteCredentials: { input: z.null(), output: localConfiguration },
  balance: { input: z.null(), output: balanceResultSchema },
});

const setupTarget = z.object({ threadId: z.string().min(1), interactionId: z.string().min(1) });
export const onboardingContract = defineRpcContract({
  getSetupInteraction: {
    input: setupTarget,
    output: z.object({ id: z.string(), kind: z.enum(["api-key", "model"]), data: z.json() }),
  },
  submitSetupInteraction: {
    input: setupTarget.extend({ answer: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("api-key"), configured: z.literal(true) }),
      z.object({ kind: z.literal("cancel") }),
    ]) }),
    output: z.null(),
  },
});
