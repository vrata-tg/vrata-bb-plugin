import { join } from "node:path";

export function resolvePiSessionFilePath(args: { sessionDir: string; threadId: string }): string {
  return join(args.sessionDir, `${args.threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
}
