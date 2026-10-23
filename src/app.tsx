import { useEffect, useRef, useState, type FormEvent } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginNavPanelProps, type PluginPendingInteractionProps, type PluginRpcResult, type StandardSchemaV1InferInput } from "@get-bb/plugin-sdk/app";
import type { configurationContract, onboardingContract } from "./contract.js";
import { hostLabel } from "./host-label.js";
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
    }, () => {
      if (!cancelled) setError("Не удалось загрузить настройки. Попробуйте открыть страницу заново.");
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
        const result = await rpc.call("saveCredentials", { target, apiKey, baseUrl: configuration.baseUrl });
        if (!active.current) return;
        setConfiguration(result);
        setApiKey("");
        setSaved(true);
      }
      if (onConfigured && active.current) {
        await onConfigured();
        if (active.current) setCompleted(true);
      }
    } catch {
      if (active.current) setError("Не удалось подключиться. Проверьте ключ и соединение и повторите попытку.");
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
      setApiKey("");
      setSaved(false);
    } catch {
      if (active.current) setError("Не удалось удалить ключ. Повторите попытку.");
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12, maxWidth: 440 }}>
      {!configuration && <span>Загружаем настройки…</span>}
      {configuration && <span role="status">{configuration.configured ? "Врата AI подключена" : "Добавьте ключ, чтобы начать"}</span>}
      {!(onConfigured && saved) && <a className="underline underline-offset-2" href="https://vrata.tg/bot" target="_blank" rel="noopener noreferrer">Получить ключ в боте Врата AI ↗</a>}
      {!(onConfigured && saved) && <>
        <label style={{ display: "grid", gap: 6 }}>Ключ API
          <input autoComplete="off" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)}
            placeholder={configuration?.configured ? "Новый ключ Врата AI" : "Ключ Врата AI"} disabled={busy || !configuration} required maxLength={4096}
            style={{ width: "100%", padding: 8, border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit" }} />
        </label>
      </>}
      {error && <span role="alert" style={{ color: "#c43d3d" }}>{error}</span>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <button className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" type="submit" disabled={busy || completed || !configuration || (!(onConfigured && saved) && !apiKey)}>
          {busy ? "Сохраняем…" : completed ? "Настройка завершена" : onConfigured ? saved ? "Продолжить запрос" : "Сохранить ключ и продолжить" : "Сохранить ключ"}
        </button>
        {!onConfigured && configuration?.configured && <button className="rounded-md border px-3 py-2 disabled:opacity-50" type="button" onClick={() => void removeKey()} disabled={busy || !configuration?.configured}>Удалить ключ</button>}
      </div>
    </form>
  );
}

function SetupRedirect({ interaction }: PluginPendingInteractionProps) {
  const navigate = useBbNavigate();
  const subPath = `thread/${interaction.threadId}/${interaction.id}`;
  useEffect(() => { navigate.toPluginPanel("setup", { subPath, replace: true }); }, [navigate, subPath]);
  return <button className="underline" onClick={() => navigate.toPluginPanel("setup", { subPath })}>Открыть подключение Врата AI</button>;
}

function MachineSettings({ initialHostId = "" }: { initialHostId?: string }) {
  const rpc = useRpc<typeof configurationContract>();
  const [hosts, setHosts] = useState<Hosts>([]);
  const [loading, setLoading] = useState(true);
  const [hostId, setHostId] = useState(initialHostId);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void rpc.call("listHosts", null).then((result) => {
      if (cancelled) return;
      setHosts(result);
      setLoading(false);
      const connected = result.filter((host) => host.status === "connected");
      const automaticHost = result.length === 1 ? result[0] : connected.length === 1 ? connected[0] : undefined;
      if (!initialHostId && automaticHost) setHostId((selected) => selected || automaticHost.id);
    }, () => {
      if (!cancelled) { setLoading(false); setError("Не удалось загрузить настройки. Откройте страницу заново."); }
    });
    return () => { cancelled = true; };
  }, [rpc]);
  return <section style={{ display: "grid", gap: 12 }}>
    {hosts.length > 1 && <label style={{ display: "grid", gap: 6 }}>Компьютер
      <select value={hostId} onChange={(event) => setHostId(event.target.value)}>
        <option value="">Выберите компьютер</option>
        {hosts.map((host, index) => <option key={host.id} value={host.id}>{hostLabel(host, index)}{host.status === "disconnected" ? " (не подключён)" : ""}</option>)}
      </select>
    </label>}
    {loading && !hostId && <span>Загружаем настройки…</span>}
    {!loading && !hosts.length && !error && <span>Подключите компьютер в bb, чтобы сохранить ключ.</span>}
    {error && <span role="alert">{error}</span>}
    {hostId && <CredentialsForm key={hostId} target={{ kind: "host", hostId }} />}
  </section>;
}

function ThreadSetup({ threadId, interactionId }: { threadId: string; interactionId: string }) {
  const rpc = useRpc<typeof onboardingContract>();
  const navigate = useBbNavigate();
  const [interaction, setInteraction] = useState<PluginRpcResult<typeof onboardingContract.getSetupInteraction> | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void rpc.call("getSetupInteraction", { threadId, interactionId }).then((result) => {
      if (!cancelled) setInteraction(result);
    }, () => { if (!cancelled) setError("Этот шаг настройки недоступен. Вернитесь в тред."); });
    return () => { cancelled = true; active.current = false; };
  }, [rpc, threadId, interactionId]);

  async function finish(answer: StandardSchemaV1InferInput<typeof onboardingContract.submitSetupInteraction.input>["answer"]) {
    await rpc.call("submitSetupInteraction", { threadId, interactionId, answer });
    if (active.current) navigate.toThread(threadId);
  }
  async function cancel() {
    setCancelling(true);
    try { await finish({ kind: "cancel" }); }
    catch { setError("Не удалось отменить настройку. Вернитесь в тред."); setCancelling(false); }
  }
  return <>
    {!interaction && !error && <span>Загружаем подключение…</span>}
    {interaction?.kind === "api-key" && <CredentialsForm target={{ kind: "thread", threadId }} onConfigured={() => finish({ kind: "api-key", configured: true })} />}
    {interaction?.kind === "model" && <ModelForm interaction={{ title: "Выберите модель", payload: interaction.data }} submit={(value) => finish({ kind: "model", ...value })} />}
    {error && <span role="alert">{error}</span>}
    {interaction && <button className="justify-self-start underline" disabled={cancelling} onClick={() => void cancel()}>Отмена</button>}
    {error && <button className="justify-self-start underline" onClick={() => navigate.toThread(threadId)}>Вернуться в тред</button>}
  </>;
}

function SetupPage({ subPath }: PluginNavPanelProps) {
  const [scope, threadId, interactionId] = subPath.split("/");
  return <section style={{ display: "grid", gap: 16, padding: 24, maxWidth: 520 }}>
    <h2 className="text-lg font-semibold">Врата AI</h2>
    {scope === "thread" && threadId && interactionId
      ? <ThreadSetup key={subPath} threadId={threadId} interactionId={interactionId} />
      : <MachineSettings key={subPath} initialHostId={subPath} />}
  </section>;
}

function VrataIcon({ className }: { className?: string }) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M10.2 0.5h11.2v19.1H10.2V0.5Z" />
    <path d="M9.2 0.5 2.8 3.1v20.3l6.4-4.1V0.5Z" />
  </svg>;
}

const reasoningLabels = {
  none: "Выкл.", low: "Низкий", medium: "Средний",
  high: "Высокий", xhigh: "Очень высокий", max: "Максимальный",
} as const;
type ReasoningLevel = keyof typeof reasoningLabels;

function ModelForm({ interaction, submit }: { interaction: Pick<PluginPendingInteractionProps["interaction"], "title" | "payload">; submit: (value: { modelId: string; reasoningLevel: ReasoningLevel }) => Promise<void> }) {
  const payload = interaction.payload;
  const data = payload;
  const rawModels = data && typeof data === "object" && !Array.isArray(data) && "models" in data ? data.models : null;
  const models = Array.isArray(rawModels) ? rawModels.filter((value): value is { id: string; name: string; reasoningLevels: ReasoningLevel[] } =>
    value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.id === "string" && typeof value.name === "string"
    && Array.isArray(value.reasoningLevels) && value.reasoningLevels.length > 0
    && value.reasoningLevels.every((level) => typeof level === "string" && Object.hasOwn(reasoningLabels, level))) : [];
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>("medium");
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
    <form onSubmit={(event) => void onSubmit(event)} style={{ display: "grid", gap: 12, maxWidth: 440 }}>
      <strong>{interaction.title}</strong>
      <label style={{ display: "grid", gap: 6 }}>Модель
        <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={busy} required>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {selected && selected.reasoningLevels.some((level) => level !== "none") && <label style={{ display: "grid", gap: 6 }}>Рассуждения
        <select value={selectedReasoning} onChange={(event) => setReasoningLevel(event.target.value as ReasoningLevel)} disabled={busy}>
          {selected.reasoningLevels.map((level) => <option key={level} value={level}>{reasoningLabels[level]}</option>)}
        </select>
      </label>}
      {error && <span role="alert" style={{ color: "#c43d3d" }}>{error}</span>}
      <button className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" type="submit" disabled={busy || !selected}>Продолжить запрос</button>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "setup", title: "Врата AI", icon: "KeyRound", path: "setup", component: SetupPage });
  app.slots.experimental_providerIcon({ providerId: "vrata", icon: VrataIcon });
  app.contentScripts.register({ id: "account-balance", mount: mountBalanceFooter });
  app.slots.settingsSection({ id: "machine-auth", title: "Врата AI", component: MachineSettings });
  app.slots.sidebarFooterAction({ id: "settings", title: "Настройки Врата AI", icon: "KeyRound", run: ({ openSettings }) => openSettings() });
  app.slots.pendingInteraction({ id: "api-key", component: SetupRedirect });
  app.slots.pendingInteraction({ id: "model", component: SetupRedirect });
});
