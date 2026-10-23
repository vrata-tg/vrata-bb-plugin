import { access, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";
import { resolvePiSessionFilePath } from "./pi/session-paths.js";

const snapshotSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant", "toolResult"]) }).passthrough()),
  selectedModelId: z.string().optional(),
  selectedReasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
});

interface LegacySessionArgs {
  dataDir: string;
  cwd: string;
  providerThreadId: string;
  sessionDir: string;
  sdkEntry: string;
}

const imports = new Map<string, Promise<string | undefined>>();

export function ensureLegacySession(args: LegacySessionArgs): Promise<string | undefined> {
  const nativePath = resolvePiSessionFilePath({ sessionDir: args.sessionDir, threadId: args.providerThreadId });
  const existing = imports.get(nativePath);
  if (existing) return existing;
  const task = importSnapshot(args, nativePath);
  imports.set(nativePath, task);
  void task.finally(() => { if (imports.get(nativePath) === task) imports.delete(nativePath); }).catch(() => {});
  return task;
}

async function importSnapshot(args: LegacySessionArgs, nativePath: string): Promise<string | undefined> {
  try { await access(nativePath); return nativePath; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Не удалось открыть сохранённую сессию Pi"); }
  // Legacy snapshots used UUID filenames. Other native session IDs have no legacy file.
  if (!/^[0-9a-f-]{36}$/i.test(args.providerThreadId)) return undefined;
  let source: string;
  try { source = await readFile(join(args.dataDir, "sessions", `${args.providerThreadId}.json`), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Не удалось прочитать прежнюю сессию Врата AI");
  }
  const temporary = `${nativePath}.${randomUUID()}.tmp`;
  try {
    const saved = snapshotSchema.parse(JSON.parse(source));
    const { SessionManager } = await import(pathToFileURL(args.sdkEntry).href) as typeof import("@earendil-works/pi-coding-agent");
    const session = SessionManager.inMemory(args.cwd, { id: args.providerThreadId });
    for (const message of saved.messages) session.appendMessage(message as Message);
    // Final selections follow history, so its last assistant cannot override them.
    const selectedModel = saved.selectedModelId;
    if (selectedModel) session.appendModelChange("vrata.tg", selectedModel);
    if (saved.selectedReasoningLevel) session.appendThinkingLevelChange(saved.selectedReasoningLevel === "none" ? "off" : saved.selectedReasoningLevel);
    await mkdir(args.sessionDir, { recursive: true, mode: 0o700 });
    const jsonl = [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(temporary, jsonl, { mode: 0o600 });
    try { await link(temporary, nativePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return nativePath;
  } catch {
    throw new Error("Не удалось перенести прежнюю сессию Врата AI. Исходная история сохранена.");
  } finally {
    await rm(temporary, { force: true });
  }
}
