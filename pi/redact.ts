import { readFileSync } from "node:fs";

/** Keep native diagnostics, excluding every credential snapshot seen by this child. */
export function createCredentialRedactor(credentialsPath: string) {
  const secrets = new Set<string>();
  function refresh(): boolean {
    try {
      const value: unknown = JSON.parse(readFileSync(credentialsPath, "utf8"));
      const key = value && typeof value === "object" && "apiKey" in value ? value.apiKey : undefined;
      if (typeof key !== "string" || !key) return false;
      secrets.add(key);
      secrets.add(JSON.stringify(key).slice(1, -1));
      secrets.add(encodeURIComponent(key));
      return true;
    } catch { return false; }
  }
  refresh();
  function text(value: string): string {
    for (const secret of secrets) value = value.split(secret).join("[redacted]");
    return value;
  }
  function value(input: unknown): unknown {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, entry]) => [key, value(entry)]));
    return input;
  }
  return { refresh, text, value };
}
