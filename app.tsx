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

function ModelForm({ interaction, submit }: PluginPendingInteractionProps) {
  const payload = interaction.payload;
  const data = payload && typeof payload === "object" && !Array.isArray(payload) && "data" in payload ? payload.data : null;
  const rawModels = data && typeof data === "object" && !Array.isArray(data) && "models" in data ? data.models : null;
  const models = Array.isArray(rawModels) ? rawModels.filter((value): value is { id: string; name: string; reasoning: boolean } =>
    value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.reasoning === "boolean") : [];
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [reasoningLevel, setReasoningLevel] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = models.find((model) => model.id === modelId);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try { await submit({ modelId, reasoningLevel: selected.reasoning ? reasoningLevel : "none" }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выбрать модель"); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12, maxWidth: 440, padding: 16 }}>
      <strong>{interaction.title}</strong>
      <label style={{ display: "grid", gap: 6 }}>Модель
        <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={busy} required>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {selected?.reasoning && <label style={{ display: "grid", gap: 6 }}>Ризонинг
        <select value={reasoningLevel} onChange={(event) => setReasoningLevel(event.target.value)} disabled={busy}>
          <option value="none">Выкл.</option><option value="low">Низкий</option><option value="medium">Средний</option>
          <option value="high">Высокий</option><option value="xhigh">Очень высокий</option><option value="max">Максимальный</option>
        </select>
      </label>}
      {error && <span role="alert" style={{ color: "#c43d3d" }}>{error}</span>}
      <button type="submit" disabled={busy || !selected}>Продолжить запрос</button>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "api-key", component: KeyForm });
  app.slots.pendingInteraction({ id: "model", component: ModelForm });
});
