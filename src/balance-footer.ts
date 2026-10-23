import type { PluginContentScriptContext, PluginRpcResult } from "@get-bb/plugin-sdk/app";
import { balanceResultSchema, formatRubles, type BalanceResult } from "./balance.js";

import { configurationContract } from "./contract.js";
import { hostLabel } from "./host-label.js";

const footerSelector = '[data-sidebar="footer"]';

export function mountBalanceFooter({ pluginId, signal }: PluginContentScriptContext): () => void {
  if (signal.aborted) return () => {};
  const rows = new Map<Element, HTMLDivElement>();
  const controller = new AbortController();
  let hosts: PluginRpcResult<typeof configurationContract.listHosts> = [];
  let hostsError = false;
  let discovering = true;
  let hostId = "";
  let requestEpoch = 0;
  let balanceController = new AbortController();
  let disposed = false;
  let busy = false;
  let refreshPending = false;
  let timer: number | undefined;
  let state: BalanceResult | null = null;

  function render(row: HTMLDivElement): void {
    const selector = row.querySelector("select")!;
    if (selector.options.length === 1 && hosts.length) {
      for (const [index, host] of hosts.entries()) {
        const option = document.createElement("option");
        option.value = host.id;
        option.textContent = `${hostLabel(host, index)}${host.status === "disconnected" ? " (не подключён)" : ""}`;
        selector.append(option);
      }
    }
    const placeholder = hostsError ? "Список машин недоступен" : "Выберите машину";
    if (selector.options[0]!.textContent !== placeholder) selector.options[0]!.textContent = placeholder;
    selector.value = hostId;
    selector.hidden = hosts.length <= 1;
    const button = row.querySelector("button")!;
    const needsKey = state?.status === "unconfigured";
    const setup = row.querySelector<HTMLAnchorElement>("[data-vrata-setup]")!;
    setup.href = `/plugins/${encodeURIComponent(pluginId)}/setup/${encodeURIComponent(hostId)}`;
    setup.style.display = needsKey ? "flex" : "none";
    setup.title = "Подключить Врата AI";
    button.style.display = needsKey ? "none" : "";
    row.querySelector<HTMLAnchorElement>("[data-vrata-top-up]")!.hidden = needsKey;
    const hasConnectedHost = hosts.some((host) => host.status === "connected");
    const pendingLabel = hostId || discovering ? "Баланс…" : hasConnectedHost ? "Выберите машину" : "Нет подключённых машин";
    const pendingTitle = hostId || discovering ? "Получаем баланс Врата AI"
      : hasConnectedHost ? "Выберите машину для просмотра баланса" : "Подключите машину с настроенным ключом Врата AI";
    const label = state?.status === "ok" ? formatRubles((BigInt(state.spendable) + BigInt(state.reserved)).toString())
      : state?.status === "error" || hostsError ? "Баланс недоступен" : state?.status === "unconfigured" ? "Ключ не настроен" : pendingLabel;
    const title = state?.status === "ok"
      ? [
        `Всего (включая резерв): ${label}`,
        `Доступно: ${formatRubles(state.spendable)}`,
        `Оплачено: ${formatRubles(state.paid)}`,
        `Бонусы: ${formatRubles(state.promo)}`,
        `В резерве: ${formatRubles(state.reserved)}`,
        `Проверено: ${new Date(state.checkedAt).toLocaleString("ru-RU")}`,
        "Нажмите, чтобы обновить",
      ].join("\n")
      : state?.status === "error" ? `${state.message}\nНажмите, чтобы обновить`
      : state?.status === "unconfigured" ? "Настройте ключ для этой машины в настройках Врата AI"
      : hostsError ? "Не удалось получить список машин BB"
      : pendingTitle;
    // Avoid needless DOM mutations: the observer also sees changes inside our rows.
    if (button.lastElementChild?.textContent !== label) button.lastElementChild!.textContent = label;
    button.title = title;
    button.disabled = busy || !hostId;
    const selectedIndex = hosts.findIndex((host) => host.id === hostId);
    const computer = hosts.length > 1 && selectedIndex >= 0 ? `, ${hostLabel(hosts[selectedIndex]!, selectedIndex)}` : "";
    button.setAttribute("aria-label", `Врата AI${computer}: ${label}. Обновить баланс`);
    button.setAttribute("aria-busy", String(busy));
  }

  function reconcile(): void {
    for (const [footer, row] of rows) {
      if (!footer.isConnected) {
        row.querySelector("button")!.removeEventListener("click", onRefresh);
        row.querySelector("select")!.removeEventListener("change", onHostChange);
        row.remove();
        rows.delete(footer);
      }
    }
    for (const footer of document.querySelectorAll(footerSelector)) {
      let row = rows.get(footer);
      if (!row) {
        row = document.createElement("div");
        row.dataset.vrataBalance = "";
        row.dataset.bbPlugin = pluginId;
        row.className = "flex w-full flex-col gap-1 text-xs text-sidebar-foreground";
        const selector = document.createElement("select");
        selector.setAttribute("aria-label", "Машина для баланса Врата AI");
        selector.className = "w-full rounded-md bg-transparent px-2 py-1.5";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Выберите машину";
        selector.append(placeholder);
        selector.addEventListener("change", onHostChange);
        const line = document.createElement("div");
        line.className = "flex w-full items-center gap-1";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2 disabled:cursor-wait";
        const name = document.createElement("span");
        name.textContent = "Врата AI";
        name.className = "shrink-0";
        const amount = document.createElement("span");
        amount.className = "truncate tabular-nums";
        button.append(name, amount);
        button.addEventListener("click", onRefresh);
        const topUp = document.createElement("a");
        topUp.dataset.vrataTopUp = "";
        topUp.href = "https://vrata.tg/bot";
        topUp.target = "_blank";
        topUp.rel = "noopener noreferrer";
        topUp.textContent = "Пополнить";
        topUp.title = "Пополнить баланс в боте Врата AI";
        topUp.className = "shrink-0 rounded-md border px-2 py-1.5 hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2";
        const setup = document.createElement("a");
        setup.dataset.vrataSetup = "";
        setup.textContent = "Добавить ключ Врата AI";
        setup.className = "w-full items-center rounded-md border px-2 py-1.5 hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2";
        line.append(button, topUp, setup);
        row.append(selector, line);
        rows.set(footer, row);
        render(row);
      }
      if (row.parentElement !== footer) footer.prepend(row);
    }
  }

  async function refresh(): Promise<void> {
    if (disposed || !hostId) return;
    const epoch = requestEpoch;
    window.clearTimeout(timer);
    if (busy) { refreshPending = true; return; }
    if (document.visibilityState === "hidden" || !navigator.onLine) {
      timer = window.setTimeout(onRefresh, 30_000);
      return;
    }
    busy = true;
    rows.forEach(render);
    try {
      const result = balanceResultSchema.parse(await rpc("balance", { hostId }, balanceController.signal));
      if (!disposed && epoch === requestEpoch) state = result;
    } catch {
      if (!disposed && epoch === requestEpoch) state = { status: "error", message: "Не удалось обновить баланс Врата AI. Повторите попытку." };
    } finally {
      if (!disposed && epoch === requestEpoch) {
        busy = false;
        rows.forEach(render);
        if (refreshPending) {
          refreshPending = false;
          void refresh();
        } else timer = window.setTimeout(onRefresh, 30_000);
      }
    }
  }

  async function rpc(method: "balance" | "listHosts" | "getConfiguration", input: unknown, requestSignal: AbortSignal): Promise<unknown> {
    const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bb-app-surface": "web" },
      credentials: "same-origin",
      body: JSON.stringify(input),
      signal: AbortSignal.any([controller.signal, requestSignal, AbortSignal.timeout(20_000)]),
    });
    const body = await response.json() as { ok?: unknown; result?: unknown };
    if (!response.ok || body?.ok !== true) throw new Error("RPC failed");
    return body.result;
  }

  function onHostChange(event: Event): void {
    selectHost((event.currentTarget as HTMLSelectElement).value);
  }

  function selectHost(value: string): void {
    hostId = value;
    discovering = false;
    requestEpoch++;
    balanceController.abort();
    balanceController = new AbortController();
    window.clearTimeout(timer);
    state = null;
    busy = false;
    refreshPending = false;
    rows.forEach(render);
    onRefresh();
  }

  function onRefresh(): void { void refresh(); }
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, { childList: true, subtree: true });
  reconcile();
  const events = new EventSource(`/api/v1/plugins/${encodeURIComponent(pluginId)}/http/balance-events`);
  // Includes an initial invalidation on connect/reconnect, covering missed completions.
  events.addEventListener("message", onRefresh);
  window.addEventListener("focus", onRefresh);
  window.addEventListener("online", onRefresh);
  document.addEventListener("visibilitychange", onRefresh);
  void rpc("listHosts", null, controller.signal).then(async (result) => {
    if (disposed) return;
    hosts = configurationContract.listHosts.output.parse(result);
    rows.forEach(render);
    const epoch = requestEpoch;
    const connected = hosts.filter((host) => host.status === "connected");
    let selected = connected[0]?.id ?? "";
    for (const host of connected) {
      try {
        const configuration = configurationContract.getConfiguration.output.parse(
          await rpc("getConfiguration", { target: { kind: "host", hostId: host.id } }, balanceController.signal),
        );
        if (disposed || epoch !== requestEpoch) return;
        if (configuration.configured) { selected = host.id; break; }
      } catch {
        if (disposed || epoch !== requestEpoch) return;
      }
    }
    selectHost(selected);
  }).catch(() => {
    if (disposed) return;
    hostsError = true;
    discovering = false;
    rows.forEach(render);
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    window.clearTimeout(timer);
    events.removeEventListener("message", onRefresh);
    events.close();
    controller.abort();
    window.removeEventListener("focus", onRefresh);
    window.removeEventListener("online", onRefresh);
    document.removeEventListener("visibilitychange", onRefresh);
    signal.removeEventListener("abort", dispose);
    for (const row of rows.values()) {
      row.querySelector("button")!.removeEventListener("click", onRefresh);
      row.querySelector("select")!.removeEventListener("change", onHostChange);
      row.remove();
    }
    rows.clear();
  }
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
