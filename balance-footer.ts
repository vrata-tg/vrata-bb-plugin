import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";
import { balanceResultSchema, formatRubles, type BalanceResult } from "./balance.js";

const footerSelector = '[data-sidebar="footer"]';

export function mountBalanceFooter({ pluginId, signal }: PluginContentScriptContext): () => void {
  if (signal.aborted) return () => {};
  const rows = new Map<Element, HTMLDivElement>();
  const controller = new AbortController();
  let disposed = false;
  let busy = false;
  let refreshPending = false;
  let timer: number | undefined;
  let state: BalanceResult | null = null;

  function render(row: HTMLDivElement): void {
    const button = row.querySelector("button")!;
    const label = state?.status === "ok" ? formatRubles(state.spendable)
      : state?.status === "error" ? "Баланс недоступен" : "Баланс…";
    const title = state?.status === "ok"
      ? [
        `Доступно: ${formatRubles(state.spendable)}`,
        `Оплачено: ${formatRubles(state.paid)}`,
        `Бонусы: ${formatRubles(state.promo)}`,
        `В резерве: ${formatRubles(state.reserved)}`,
        `Проверено: ${new Date(state.checkedAt).toLocaleString("ru-RU")}`,
        "Нажмите, чтобы обновить",
      ].join("\n")
      : state?.status === "error" ? `${state.message}\nНажмите, чтобы обновить` : "Получаем баланс Врата AI";
    // Avoid needless DOM mutations: the observer also sees changes inside our rows.
    if (button.lastElementChild?.textContent !== label) button.lastElementChild!.textContent = label;
    button.title = title;
    row.hidden = state?.status === "unconfigured";
    row.style.display = row.hidden ? "none" : "";
    button.disabled = busy;
    button.setAttribute("aria-label", `Врата AI: ${label}. Обновить баланс`);
    button.setAttribute("aria-busy", String(busy));
  }

  function reconcile(): void {
    for (const [footer, row] of rows) {
      if (!footer.isConnected) {
        row.querySelector("button")!.removeEventListener("click", onRefresh);
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
        row.className = "flex w-full items-center gap-1 text-xs text-sidebar-foreground";
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
        topUp.href = "https://vrata.tg/bot";
        topUp.target = "_blank";
        topUp.rel = "noopener noreferrer";
        topUp.textContent = "Пополнить";
        topUp.title = "Пополнить баланс в боте Врата AI";
        topUp.className = "shrink-0 rounded-md border px-2 py-1.5 hover:bg-sidebar-accent focus-visible:outline focus-visible:outline-2";
        row.append(button, topUp);
        rows.set(footer, row);
        render(row);
      }
      if (row.parentElement !== footer) footer.prepend(row);
    }
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    window.clearTimeout(timer);
    if (busy) { refreshPending = true; return; }
    if (document.visibilityState === "hidden" || !navigator.onLine) {
      timer = window.setTimeout(onRefresh, 30_000);
      return;
    }
    busy = true;
    rows.forEach(render);
    try {
      const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/balance`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bb-app-surface": "web" },
        credentials: "same-origin",
        body: "null",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      const body = await response.json() as { ok?: unknown; result?: unknown };
      if (!response.ok || body?.ok !== true) throw new Error("Balance RPC failed");
      const result = balanceResultSchema.parse(body.result);
      if (!disposed) state = result;
    } catch {
      if (!disposed) state = { status: "error", message: "Не удалось обновить баланс Врата AI. Повторите попытку." };
    } finally {
      busy = false;
      if (!disposed) {
        rows.forEach(render);
        if (refreshPending) {
          refreshPending = false;
          void refresh();
        } else timer = window.setTimeout(onRefresh, 30_000);
      }
    }
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
  onRefresh();

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
      row.remove();
    }
    rows.clear();
  }
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
