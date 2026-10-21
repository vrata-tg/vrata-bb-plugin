import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import runtime from "#vrata-pi-runtime";

export async function ensureEmbeddedPi(dataDir: string) {
  const cacheDir = join(dataDir, "pi-runtime");
  const runtimeRoot = join(cacheDir, `${runtime.version}-${runtime.sha256}`);
  const entries = {
    runtimeRoot,
    rpcEntry: join(runtimeRoot, "dist/bundle/rpc-entry.js"),
    sdkEntry: join(runtimeRoot, "dist/bundle/index.js"),
  };
  async function isPublished() {
    try {
      return await readFile(join(runtimeRoot, ".complete"), "utf8") === runtime.sha256;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  if (await isPublished()) return entries;

  const files = runtime.files;
  const digest = createHash("sha256");
  for (const [path, bytes] of Object.entries(files)) {
    digest.update(JSON.stringify([path, bytes.byteLength])).update(bytes);
  }
  if (digest.digest("hex") !== runtime.sha256) {
    throw new Error("Embedded Pi runtime checksum mismatch");
  }
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(cacheDir, ".extract-"));
  try {
    for (const [path, bytes] of Object.entries(files)) {
      if (isAbsolute(path) || path.includes("\\") || path.split("/").includes("..")) {
        throw new Error("Invalid embedded Pi runtime path");
      }
      const destination = join(staging, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { mode: 0o600 });
    }
    await writeFile(join(staging, ".complete"), runtime.sha256, { mode: 0o600 });
    try {
      await rename(staging, runtimeRoot);
    } catch (error) {
      // Another host may have published the same immutable capsule first.
      if (!await isPublished()) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return entries;
}
