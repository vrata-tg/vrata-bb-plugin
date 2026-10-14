import { useState, type FormEvent } from "react";
import { definePluginApp, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { setupContract } from "./contract.js";

function KeyForm({ interaction, submit }: PluginPendingInteractionProps) {
  const rpc = useRpc<typeof setupContract>();
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!saved) {
        await rpc.call("validateKey", { apiKey: apiKey.trim() });
        const response = await fetch("/api/v1/plugins/vrata/settings", {
          method: "PUT",
          headers: { "content-type": "application/json", "x-bb-app-surface": "web" },
          credentials: "same-origin",
          body: JSON.stringify({ values: { apiKey: apiKey.trim() } }),
        });
        const result: unknown = await response.json();
        if (!response.ok || !result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
          const message = result && typeof result === "object" && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "Не удалось сохранить ключ Врата AI";
          throw new Error(message);
        }
        setSaved(true);
        setApiKey("");
      }
      await rpc.call("waitForKey", null);
      await submit({ configured: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить ключ. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12, maxWidth: 440, padding: 16 }}>
      <strong>{interaction.title}</strong>
      <span>Введите ключ Врата AI. После проверки исходный запрос продолжится автоматически.</span>
      {!saved && (
        <label style={{ display: "grid", gap: 6 }}>
          Ключ API
          <input
            autoFocus
            autoComplete="off"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Ключ Врата AI"
            disabled={busy}
            required
            style={{ width: "100%", padding: 8, border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit" }}
          />
        </label>
      )}
      {error && <span role="alert" style={{ color: "#c43d3d" }}>{error}</span>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="submit" disabled={busy || (!saved && !apiKey.trim())} style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid currentColor" }}>
          {busy ? "Проверяем…" : saved ? "Продолжить запрос" : "Сохранить ключ и продолжить"}
        </button>
        <a href="https://vrata.tg/bot" target="_blank" rel="noopener noreferrer">Получить ключ</a>
      </div>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "api-key", component: KeyForm });
});
