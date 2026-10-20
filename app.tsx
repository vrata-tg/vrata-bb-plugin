import { useState, type FormEvent } from "react";
import { definePluginApp, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { setupContract } from "./contract.js";
import { mountBalanceFooter } from "./balance-footer.js";

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
        const result: unknown = await response.json().catch(() => null);
        if (!response.ok || !result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
          throw new Error("Не удалось сохранить ключ Врата AI");
        }
        setSaved(true);
        setApiKey("");
      }
      await rpc.call("waitForKey", { threadId: interaction.threadId });
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

const reasoningLabels: Record<string, string> = {
  none: "Выкл.", low: "Низкий", medium: "Средний",
  high: "Высокий", xhigh: "Очень высокий", max: "Максимальный",
};

function ModelForm({ interaction, submit }: PluginPendingInteractionProps) {
  const payload = interaction.payload;
  const data = payload && typeof payload === "object" && !Array.isArray(payload) && "data" in payload ? payload.data : null;
  const rawModels = data && typeof data === "object" && !Array.isArray(data) && "models" in data ? data.models : null;
  const models = Array.isArray(rawModels) ? rawModels.filter((value): value is { id: string; name: string; reasoningLevels: string[] } =>
    value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" && typeof value.name === "string"
    && Array.isArray(value.reasoningLevels) && value.reasoningLevels.length > 0
    && value.reasoningLevels.every((level) => typeof level === "string" && Object.hasOwn(reasoningLabels, level))) : [];
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [reasoningLevel, setReasoningLevel] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = models.find((model) => model.id === modelId);
  const selectedReasoning = selected?.reasoningLevels.includes(reasoningLevel) ? reasoningLevel
    : selected?.reasoningLevels.includes("medium") ? "medium" : selected?.reasoningLevels[0];

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !selectedReasoning || busy) return;
    setBusy(true);
    setError("");
    try { await submit({ modelId, reasoningLevel: selectedReasoning }); }
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
      {selected && selected.reasoningLevels.some((level) => level !== "none") && <label style={{ display: "grid", gap: 6 }}>Ризонинг
        <select value={selectedReasoning} onChange={(event) => setReasoningLevel(event.target.value)} disabled={busy}>
          {selected.reasoningLevels.map((level) => <option key={level} value={level}>{reasoningLabels[level]}</option>)}
        </select>
      </label>}
      {error && <span role="alert" style={{ color: "#c43d3d" }}>{error}</span>}
      <button type="submit" disabled={busy || !selected}>Продолжить запрос</button>
    </form>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "account-balance", mount: mountBalanceFooter });
  app.slots.pendingInteraction({ id: "api-key", component: KeyForm });
  app.slots.pendingInteraction({ id: "model", component: ModelForm });
});
