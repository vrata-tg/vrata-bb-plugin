import { useEffect, useRef, useState, type FormEvent } from "react";
import { definePluginApp, useRpc, type PluginNavPanelProps, type PluginPendingInteractionProps, type PluginRpcResult, type StandardSchemaV1InferInput } from "@get-bb/plugin-sdk/app";
import type { configurationContract } from "./contract.js";
import { mountBalanceFooter } from "./balance-footer.js";

type Target = StandardSchemaV1InferInput<typeof configurationContract.saveCredentials.input>["target"];
type Configuration = PluginRpcResult<typeof configurationContract.getConfiguration>;
type Hosts = PluginRpcResult<typeof configurationContract.listHosts>;

function CredentialsForm({ target, onConfigured }: { target: Target; onConfigured?: () => Promise<void> }) {
  const rpc = useRpc<typeof configurationContract>();
  const active = useRef(false);
  const inFlight = useRef(false);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saved, setSaved] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Callers key this component by target/interaction, clearing fields on scope change.
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void rpc.call("getConfiguration", { target }).then((result) => {
      if (cancelled) return;
      setConfiguration(result);
      setBaseUrl(result.baseUrl);
    }, () => {
      if (!cancelled) setError("Не удалось прочитать настройку машины. Выберите её заново.");
    });
    return () => { cancelled = true; active.current = false; };
  }, [rpc]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || completed || !configuration) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!saved || !onConfigured) {
        const result = await rpc.call("saveCredentials", { target, apiKey, baseUrl });
        if (!active.current) return;
        setConfiguration(result);
        setBaseUrl(result.baseUrl);
        setApiKey("");
        setSaved(true);
      }
      if (onConfigured && active.current) {
        await onConfigured();
        if (active.current) setCompleted(true);
      }
    } catch {
      if (active.current) setError("Не удалось завершить настройку машины. Проверьте подключение, ключ и адрес API и повторите попытку.");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function removeKey() {
    if (inFlight.current || !configuration) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("deleteCredentials", { hostId: configuration.hostId });
      if (!active.current) return;
      setConfiguration(result);
      setBaseUrl(result.baseUrl);
      setApiKey("");
      setSaved(false);
    } catch {
      if (active.current) setError("Не удалось удалить ключ на выбранной машине. Повторите попытку.");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12, maxWidth: 440 }}>
      {configuration ? <span>Машина: <strong>{configuration.hostName}</strong></span> : <span>Загружаем настройку машины…</span>}
      {configuration && <span role="status">{configuration.configured ? "Ключ сохранён на этой машине" : "Ключ на этой машине не настроен"}</span>}
      {!(onConfigured && saved) && <>
        <label style={{ display: "grid", gap: 6 }}>Ключ API
          <input autoComplete="off" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
            placeholder={configuration?.configured ? "Новый ключ Врата AI" : "Ключ Врата AI"} disabled={busy || !configuration} required maxLength={4096}
            style={{ width: "100%", padding: 8, border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit" }} />
        </label>
        <details>
          <summary>Адрес API</summary>
          <label style={{ display: "grid", gap: 6 }}>Адрес API
            <input type="url" autoComplete="off" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={busy || !configuration} required />
          </label>
        </details>
      </>}
      {error && <span role="alert" style={{ color: "#c43d3d" }}>{error}</span>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <button className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" type="submit" disabled={busy || completed || !configuration || (!(onConfigured && saved) && (!apiKey || !baseUrl))}>
          {busy ? "Сохраняем…" : completed ? "Настройка завершена" : onConfigured ? saved ? "Продолжить запрос" : "Сохранить ключ и продолжить" : "Сохранить ключ"}
        </button>
        {!onConfigured && <button className="rounded-md border px-3 py-2 disabled:opacity-50" type="button" onClick={() => void removeKey()} disabled={busy || !configuration?.configured}>Удалить ключ</button>}
        <a className="underline underline-offset-2" href="https://vrata.tg/bot" target="_blank" rel="noopener noreferrer">Получить ключ</a>
      </div>
    </form>
  );
}

function KeyForm({ interaction, submit }: PluginPendingInteractionProps) {
  return <section style={{ display: "grid", gap: 12, padding: 16 }}>
    <strong>{interaction.title}</strong>
    <span>Сохраните ключ на машине треда. После проверки исходный запрос продолжится автоматически.</span>
    <CredentialsForm key={`${interaction.threadId}:${interaction.id}`} target={{ kind: "thread", threadId: interaction.threadId }} onConfigured={() => submit({ configured: true })} />
  </section>;
}

function MachineSettings({ initialHostId = "" }: { initialHostId?: string }) {
  const rpc = useRpc<typeof configurationContract>();
  const [hosts, setHosts] = useState<Hosts>([]);
  const [hostId, setHostId] = useState(initialHostId);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void rpc.call("listHosts", null).then((result) => {
      if (cancelled) return;
      setHosts(result);
      const connected = result.filter((host) => host.status === "connected");
      if (!initialHostId && connected.length === 1) setHostId((selected) => selected || connected[0]!.id);
    }, () => {
      if (!cancelled) setError("Не удалось получить список машин. Откройте настройки заново.");
    });
    return () => { cancelled = true; };
  }, [rpc]);
  return <section style={{ display: "grid", gap: 12 }}>
    <span>Получите ключ в <a href="https://vrata.tg/bot" target="_blank" rel="noopener noreferrer">боте Врата AI</a> и сохраните его на машине, где будут выполняться запросы. Ключ не синхронизируется с другими машинами.</span>
    <label style={{ display: "grid", gap: 6 }}>Машина
      <select value={hostId} onChange={(event) => setHostId(event.target.value)}>
        <option value="">Выберите машину</option>
        {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}{host.status === "disconnected" ? " (не подключена)" : ""}</option>)}
      </select>
    </label>
    {!hosts.length && !error && <span>Для настройки подключите машину в bb.</span>}
    {error && <span role="alert">{error}</span>}
    {hostId && <CredentialsForm key={hostId} target={{ kind: "host", hostId }} />}
  </section>;
}

function SetupPage({ subPath }: PluginNavPanelProps) {
  return <section style={{ display: "grid", gap: 16, padding: 24, maxWidth: 520 }}>
    <h2 className="text-lg font-semibold">Подключить Врата AI</h2>
    <MachineSettings key={subPath} initialHostId={subPath} />
    <span>После сохранения ключа выберите провайдер «Врата AI (Pi)» в новом треде и отправьте сообщение.</span>
  </section>;
}

function VrataIcon({ className }: { className?: string }) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M10.2 0.5h11.2v19.1H10.2V0.5Z" />
    <path d="M9.2 0.5 2.8 3.1v20.3l6.4-4.1V0.5Z" />
  </svg>;
}

const reasoningLabels: Record<string, string> = {
  none: "Выкл.", low: "Низкий", medium: "Средний",
  high: "Высокий", xhigh: "Очень высокий", max: "Максимальный",
};

function ModelForm({ interaction, submit }: PluginPendingInteractionProps) {
  const payload = interaction.payload;
  const data = payload;
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
  app.slots.navPanel({ id: "setup", title: "Подключить Врата AI", icon: "KeyRound", path: "setup", component: SetupPage });
  app.slots.experimental_providerIcon({ providerId: "vrata", icon: VrataIcon });
  app.contentScripts.register({ id: "account-balance", mount: mountBalanceFooter });
  app.slots.settingsSection({ id: "machine-auth", title: "Врата AI на машине", component: MachineSettings });
  app.slots.sidebarFooterAction({ id: "settings", title: "Настройки Врата AI", icon: "KeyRound", run: ({ openSettings }) => openSettings() });
  app.slots.pendingInteraction({ id: "api-key", component: KeyForm });
  app.slots.pendingInteraction({ id: "model", component: ModelForm });
});
