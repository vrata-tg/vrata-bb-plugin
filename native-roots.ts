// Adapted from BB provider-pi; provenance and license: native-pi/NOTICE.md.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export const PI_NATIVE_ROOTS_DECLARATION: Pick<
  PluginProviderDeclaration,
  "experimental_nativeSkillRoots" | "experimental_resolvesNativeRoots"
> = {
  experimental_nativeSkillRoots: {
    user: [".agents/skills"],
    project: [".pi/skills", ".agents/skills"],
  },
  experimental_resolvesNativeRoots: true,
};

const piSettingsSchema = z
  .object({ skills: z.array(z.string()).optional() })
  .passthrough();

export interface ResolvePiNativeRootsArgs {
  homeDir: string;
  agentDir: string;
}

function resolveStoredPath(
  homeDir: string,
  value: string,
  baseDir: string,
): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function isPlainSkillSource(value: string): boolean {
  return !/^(?:npm:|git:|https?:\/\/|git@)/u.test(value);
}

export async function resolvePiNativeRoots(
  args: ResolvePiNativeRootsArgs,
): Promise<ExperimentalNativeRootsResolveAnswer> {
  const agentDir = args.agentDir;
  const roots = new Set<string>([path.resolve(agentDir, "skills")]);
  let settings: z.infer<typeof piSettingsSchema> | null = null;
  try {
    settings = piSettingsSchema.parse(
      JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")),
    );
  } catch {
    settings = null;
  }
  for (const raw of settings?.skills ?? []) {
    const value = raw.trim();
    if (
      value.length === 0 ||
      value.startsWith("!") ||
      !isPlainSkillSource(value)
    ) {
      continue;
    }
    if (path.extname(value).toLowerCase() === ".md") {
      continue;
    }
    roots.add(path.resolve(resolveStoredPath(args.homeDir, value, agentDir)));
  }
  return {
    skills: experimental_filterResolvedNativeRoots(
      {
        skills: [...roots].sort().map((rootPath) => ({
          path: rootPath,
          origin: "user" as const,
          shape: "skills" as const,
        })),
      },
      { warn: console.warn },
    ).answer.skills,
  };
}
