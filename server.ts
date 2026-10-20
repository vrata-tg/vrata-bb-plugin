import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { accountContract, credentialsContract, DEFAULT_BASE_URL, setupContract } from "./contract.js";
import { apiBaseUrl, fetchModels } from "./vrata.js";
import { fetchBalance } from "./balance.js";
import { registerBalanceEvents } from "./balance-events.js";

const setupModel = {
  id: "vrata-setup",
  model: "vrata-setup",
  displayName: "Ввести ключ и выбрать модель",
  routeProviderId: "vrata",
  description: "Ввести ключ и выбрать модель в треде",
  supportedReasoningEfforts: [{ reasoningEffort: "none" as const, description: "Без рассуждений" }],
  defaultReasoningEffort: "none" as const,
  isDefault: true,
};

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    apiKey: { type: "string", label: "Ключ API Врата AI", secret: true },
    baseUrl: { type: "string", label: "Адрес API", default: DEFAULT_BASE_URL },
  });
  const host = bb.hosts.experimental_client({ contract: credentialsContract });
  let disposed = false;
  let requested = false;
  let settingsRevision = 0;
  let syncTask: Promise<void> | undefined;
  const hostSyncs = new Map<string, Promise<boolean>>();

  function syncHost(hostId: string): Promise<boolean> {
    // Read settings inside the host's queue so an older background write cannot
    // overtake onboarding. Recheck after acknowledgement before declaring success.
    const task = (hostSyncs.get(hostId) ?? Promise.resolve(false)).catch(() => false).then(async () => {
      while (!disposed) {
        const values = await settings.get();
        const result = await host.call("sync", {
          apiKey: values.apiKey ?? "",
          baseUrl: values.baseUrl,
        }, { hostId });
        const current = await settings.get();
        if (values.apiKey === current.apiKey && values.baseUrl === current.baseUrl) {
          return !disposed && Boolean(values.apiKey?.trim()) && result.configured === true;
        }
      }
      return false;
    });
    hostSyncs.set(hostId, task);
    void task.finally(() => {
      if (hostSyncs.get(hostId) === task) hostSyncs.delete(hostId);
    }).catch(() => {});
    return task;
  }

  function sync(): Promise<void> {
    requested = true;
    if (syncTask) return syncTask;
    syncTask = (async () => {
      try {
        while (requested && !disposed) {
          requested = false;
          const hosts = await bb.sdk.hosts.list();
          const results = await Promise.allSettled(hosts.map((machine) => syncHost(machine.id)));
          for (const result of results) {
            if (result.status === "rejected") bb.log.warn("Could not synchronize a Врата AI machine");
          }
        }
      } finally {
        syncTask = undefined;
      }
    })();
    return syncTask;
  }

  function backgroundSync(): void {
    void sync().catch(() => bb.log.warn("Could not synchronize Врата AI configuration"));
  }
  settings.onChange(() => { settingsRevision += 1; backgroundSync(); refreshProvider(); });
  bb.background.service("credentials", {
    start(signal) {
      backgroundSync();
      const timer = setInterval(backgroundSync, 30_000);
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { clearInterval(timer); resolve(); }, { once: true });
      });
    },
  });
  bb.onDispose(() => { disposed = true; });

  const balanceController = new AbortController();
  registerBalanceEvents(bb);
  bb.onDispose(() => balanceController.abort());
  bb.rpc.register(accountContract, {
    async balance() {
      const { apiKey, baseUrl } = await settings.get();
      if (!apiKey?.trim()) return { status: "unconfigured" as const };
      return fetchBalance(apiBaseUrl(baseUrl), apiKey, balanceController.signal);
    },
  });

  bb.rpc.register(setupContract, {
    async validateKey({ apiKey }) {
      try {
        const { baseUrl } = await settings.get();
        const models = await fetchModels({ apiKey, baseUrl });
        if (models.length > 0) return { valid: true as const };
      } catch {
        throw new Error("Не удалось проверить ключ Врата AI. Проверьте ключ и адрес API.");
      }
      throw new Error("Для этого ключа нет доступных моделей Врата AI");
    },
    async waitForKey({ threadId }) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId) {
          const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          while (!disposed) {
            const revision = settingsRevision;
            const configured = await syncHost(environment.hostId);
            if (revision !== settingsRevision) continue;
            if (configured) return { configured: true as const };
            break;
          }
        }
      } catch {
        // Host/SDK errors can contain credentials or request details.
      }
      throw new Error("Не удалось передать актуальный ключ на машину с тредом. Повторите попытку.");
    },
  });

  function registerProvider() { return bb.providers.register({
    id: "vrata",
    displayName: "Врата AI (Pi)",
    icon: "Sparkles",
    family: "pi",
    strings: {
      signInHint: "Первый запрос в треде откроет форму для ключа Врата AI.",
      expiredHint: "Проверьте ключ и баланс Врата AI в настройках плагина.",
      installUrl: "https://vrata.tg/bot",
      brandPrefix: "Врата AI ",
    },
    maintenance: { health: true, usage: false, installation: false },
    composerActions: [],
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    models: { fallback: [setupModel], scope: "host" },
  }); }
  let provider = registerProvider();
  function refreshProvider(): void {
    provider.dispose();
    provider = registerProvider();
  }
}
