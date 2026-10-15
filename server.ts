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
  let syncTask: Promise<boolean> | undefined;

  function sync(): Promise<boolean> {
    requested = true;
    if (syncTask) return syncTask;
    syncTask = (async () => {
      let succeeded = false;
      while (requested && !disposed) {
        requested = false;
        const values = await settings.get();
        const hosts = await bb.sdk.hosts.list();
        const results = await Promise.allSettled(hosts.map((machine) => host.call("sync", {
          apiKey: values.apiKey ?? "",
          baseUrl: values.baseUrl,
        }, { hostId: machine.id })));
        succeeded = results.some((result) => result.status === "fulfilled");
        for (const result of results) {
          if (result.status === "rejected") bb.log.warn(`Could not synchronize a Врата AI machine: ${String(result.reason)}`);
        }
      }
      return succeeded;
    })().finally(() => { syncTask = undefined; });
    return syncTask;
  }

  function backgroundSync(): void {
    void sync().catch((error) => bb.log.warn(`Could not synchronize Врата AI configuration: ${String(error)}`));
  }
  settings.onChange(() => { backgroundSync(); refreshProvider(); });
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
      const { baseUrl } = await settings.get();
      const models = await fetchModels({ apiKey, baseUrl });
      if (models.length === 0) throw new Error("Для этого ключа нет доступных моделей Врата AI");
      return { valid: true as const };
    },
    async waitForKey() {
      const { apiKey } = await settings.get();
      if (!apiKey) throw new Error("Ключ Врата AI не сохранён");
      if (!await sync()) throw new Error("Не удалось передать ключ на машину с тредом. Повторите попытку.");
      return { configured: true as const };
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
