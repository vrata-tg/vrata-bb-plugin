import { streamSimple } from "@earendil-works/pi-ai/compat";

export const streamVrata: typeof streamSimple = (model, context, options) => streamSimple(model, context, {
  ...options,
  fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  maxRetries: 0,
  transport: "sse",
});
