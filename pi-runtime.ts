import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureEmbeddedPi } from "./embedded-pi.js";
import { VRATA_EXTENSION_SOURCE, VRATA_PI_SETTINGS } from "./vrata-extension.js";

export async function preparePiRuntime(dataDir: string) {
  const runtime = await ensureEmbeddedPi(dataDir);
  const agentDir = join(dataDir, "pi-agent");
  const sessionDir = join(dataDir, "pi-sessions");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  // Seed this installation once. Pi owns subsequent native settings updates.
  try {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(VRATA_PI_SETTINGS), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const extensionPath = join(dataDir, "vrata-extension.mjs");
  let previous: string | undefined;
  try { previous = await readFile(extensionPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (previous !== VRATA_EXTENSION_SOURCE) {
    const temporary = `${extensionPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, VRATA_EXTENSION_SOURCE, { mode: 0o600 });
      await rename(temporary, extensionPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return {
    ...runtime, agentDir, sessionDir, extensionPath,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      VRATA_CREDENTIALS_PATH: join(dataDir, "credentials.json"),
      OPENAI_LOG: "off",
      ANTHROPIC_LOG: "off",
    } satisfies NodeJS.ProcessEnv,
  };
}
