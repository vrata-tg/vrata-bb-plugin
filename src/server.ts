import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { accountContract, configurationContract, credentialsContract, onboardingContract, type ConfigurationTarget } from "./contract.js";
import { registerBalanceEvents } from "./balance-events.js";
import manifest from "../package.json" with { type: "json" };
import type { VrataClient } from "./contract.js";

export default function plugin(bb: BbPluginApi): void {
  const client: VrataClient = {
    distribution: "vrataDistribution" in manifest && manifest.vrataDistribution === "vrata-bb" ? "vrata-bb" : "vrata-bb-plugin",
    bbVersion: process.env.BB_APP_VERSION ?? "unknown",
  };
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
        const config = await host.call("saveCredentials", { apiKey, baseUrl, client }, { hostId: machine.id, signal });
        signal.throwIfAborted();
        if (!config.configured) throw new Error("Host did not confirm configuration");
        await refreshProvider();
        signal.throwIfAborted();
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
        await refreshProvider();
        signal.throwIfAborted();
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
        const balance = await host.call("balance", { client }, { hostId: machine.id, signal });
        signal.throwIfAborted();
        return balance;
      } catch {
        return { status: "error" as const, message: "Баланс Врата AI на выбранной машине временно недоступен. Проверьте подключение." };
      }
    },
  });

  async function getSetupInteraction(target: { threadId: string; interactionId: string }) {
    const interaction = await bb.sdk.threads.interactions.get({ ...target, signal });
    signal.throwIfAborted();
    if (interaction.threadId !== target.threadId || interaction.status !== "pending"
      || !("providerId" in interaction) || interaction.providerId !== "vrata" || interaction.payload.kind !== `${bb.pluginId}/api-key`) {
      throw new Error("Настройка больше не ожидает ответа. Вернитесь в тред.");
    }
    return { id: interaction.id, kind: "api-key" as const, data: "data" in interaction.payload ? interaction.payload.data : null };
  }

  bb.rpc.register(onboardingContract, {
    getSetupInteraction,
    async submitSetupInteraction({ threadId, interactionId, answer }) {
      const target = { threadId, interactionId };
      await getSetupInteraction(target);
      if (answer.kind === "cancel") await bb.sdk.threads.stop({ threadId });
      else {
        await bb.sdk.threads.interactions.respond({ ...target, value: { configured: true } });
      }
      return null;
    },
  });

  function registerProvider() { return bb.providers.register({
    id: "vrata",
    displayName: "Врата AI",
    icon: "./media/vrata.svg",
    family: "pi",
    experimental_bridgeOptions: { vrataClient: client },
    strings: {
      signInHint: "Добавьте ключ на странице Врата AI.",
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
    models: { scope: "host" },
  }); }
  let provider = registerProvider();
  async function refreshProvider(): Promise<void> {
    provider.dispose();
    provider = registerProvider();
    // SDK 0.4.34 re-registration clears server caches but does not notify pickers.
    await bb.sdk.system.reloadConfig();
  }
}
