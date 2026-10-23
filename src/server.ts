import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { accountContract, configurationContract, credentialsContract, type ConfigurationTarget } from "./contract.js";
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
  const host = bb.hosts.experimental_client({ contract: credentialsContract });
  const controller = new AbortController();
  const signal = controller.signal;
  bb.onDispose(() => controller.abort());
  const notify = registerBalanceEvents(bb);

  async function resolveTarget(target: ConfigurationTarget) {
    signal.throwIfAborted();
    let hostId: string;
    if (target.kind === "thread") {
      const thread = await bb.sdk.threads.get({ threadId: target.threadId, signal });
      if (!thread.environmentId) throw new Error("Thread has no environment");
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal });
      hostId = environment.hostId;
    } else {
      hostId = target.hostId;
    }
    const machine = await bb.sdk.hosts.get({ hostId, signal });
    signal.throwIfAborted();
    return machine;
  }

  bb.rpc.register(configurationContract, {
    async listHosts() {
      try {
        const machines = await bb.sdk.hosts.list({ signal });
        signal.throwIfAborted();
        return machines.map(({ id, name, status }) => ({ id, name, status }));
      } catch {
        throw new Error("Не удалось получить список машин BB. Повторите попытку.");
      }
    },
    async getConfiguration({ target }) {
      try {
        const machine = await resolveTarget(target);
        const config = await host.call("getConfiguration", null, { hostId: machine.id, signal });
        signal.throwIfAborted();
        return { hostId: machine.id, hostName: machine.name, ...config };
      } catch {
        throw new Error("Не удалось прочитать настройки Врата AI на выбранной машине. Проверьте подключение.");
      }
    },
    async saveCredentials({ target, apiKey, baseUrl }) {
      try {
        const machine = await resolveTarget(target);
        const config = await host.call("saveCredentials", { apiKey, baseUrl }, { hostId: machine.id, signal });
        signal.throwIfAborted();
        if (!config.configured) throw new Error("Host did not confirm configuration");
        refreshProvider();
        notify();
        return { hostId: machine.id, hostName: machine.name, ...config };
      } catch {
        throw new Error("Не удалось проверить и сохранить ключ Врата AI на выбранной машине. Проверьте подключение, ключ и адрес API.");
      }
    },
    async deleteCredentials({ hostId }) {
      try {
        const machine = await resolveTarget({ kind: "host", hostId });
        const config = await host.call("deleteCredentials", null, { hostId: machine.id, signal });
        signal.throwIfAborted();
        refreshProvider();
        notify();
        return { hostId: machine.id, hostName: machine.name, ...config };
      } catch {
        throw new Error("Не удалось удалить ключ Врата AI на выбранной машине. Проверьте подключение.");
      }
    },
  });

  bb.rpc.register(accountContract, {
    async balance({ hostId }) {
      try {
        const machine = await resolveTarget({ kind: "host", hostId });
        const balance = await host.call("balance", null, { hostId: machine.id, signal });
        signal.throwIfAborted();
        return balance;
      } catch {
        return { status: "error" as const, message: "Баланс Врата AI на выбранной машине временно недоступен. Проверьте подключение." };
      }
    },
  });

  function registerProvider() { return bb.providers.register({
    id: "vrata",
    displayName: "Врата AI (Pi)",
    icon: "./media/vrata.svg",
    family: "pi",
    strings: {
      signInHint: "Первый запрос в треде откроет форму для ключа Врата AI.",
      expiredHint: "Проверьте ключ и баланс Врата AI в настройках плагина.",
      installUrl: "https://vrata.tg/bot",
      brandPrefix: "Врата AI ",
    },
    maintenance: { health: true, usage: false, installation: false },
    experimental_nativeSkillRoots: {
      user: [".agents/skills"],
      project: [".pi/skills", ".agents/skills"],
    },
    experimental_resolvesNativeRoots: true,
    composerActions: [],
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
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
