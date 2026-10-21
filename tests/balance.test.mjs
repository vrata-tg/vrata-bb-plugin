import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { fetchBalance, formatRubles } from "../dist/tests/balance.js";
import { mountBalanceFooter } from "../dist/tests/balance-footer.js";
import { registerBalanceEvents } from "../dist/tests/balance-events.js";

const account = {
  checked_at: "2026-10-15T10:00:00+00:00",
  balance: { currency: "RUB", unit: "coin_atoms", paid_available: "1000000", promo_available: "300000", reserved: "200000", spendable: "1300000" },
};
const balance = { status: "ok", checkedAt: account.checked_at, paid: "1000000", promo: "300000", reserved: "200000", spendable: "1300000" };

test("ruble formatting preserves large integers and rounds at the kopeck boundary", () => {
  assert.equal(formatRubles("0"), "0,00 ₽");
  assert.equal(formatRubles("1300000"), "1,30 ₽");
  assert.equal(formatRubles("9994999"), "9,99 ₽");
  assert.equal(formatRubles("9995000"), "10,00 ₽");
  assert.equal(formatRubles("-15000"), "−0,02 ₽");
  assert.equal(formatRubles("-1"), "0,00 ₽");
  assert.equal(formatRubles("900719925474099312345000"), "900\u00a0719\u00a0925\u00a0474\u00a0099\u00a0312,35 ₽");
});

test("account API authenticates on the host, parses atoms, and hides upstream errors", async (t) => {
  let status = 200;
  let payload = account;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/account");
    assert.equal(request.headers.authorization, "Bearer secret-test-key");
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1`;
  assert.deepEqual(await fetchBalance(apiUrl, "secret-test-key"), balance);
  for (const errorStatus of [401, 403, 429, 500]) {
    status = errorStatus;
    payload = { error: "secret-test-key upstream-private-detail" };
    const result = await fetchBalance(apiUrl, "secret-test-key");
    assert.equal(result.status, "error");
    assert.doesNotMatch(JSON.stringify(result), /secret-test-key|upstream-private-detail/);
  }
  status = 200;
  for (const badBalance of [
    { ...account.balance, currency: "USD" },
    { ...account.balance, unit: "rubles" },
    { ...account.balance, spendable: 1300000 },
    { ...account.balance, spendable: "NaN" },
  ]) {
    payload = { ...account, balance: badBalance };
    assert.equal((await fetchBalance(apiUrl, "secret-test-key")).status, "error");
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal((await fetchBalance(apiUrl, "secret-test-key", controller.signal)).status, "error");
});

async function settle() {
  // Allow fetch promises and DOM mutation observer callbacks to finish.
  await new Promise((resolve) => setImmediate(resolve));
}

function client(t, fetcher) {
  const dom = new JSDOM('<body><aside><div data-sidebar="footer"><a>Settings</a></div></aside></body>', { pretendToBeVisual: true });
  const originals = new Map();
  const timers = new Map();
  const sources = [];
  let timerId = 0;
  class FakeEventSource extends dom.window.EventTarget {
    closed = false;
    constructor(url) { super(); this.url = url; sources.push(this); }
    close() { this.closed = true; }
    refresh() { this.dispatchEvent(new dom.window.MessageEvent("message", { data: "refresh" })); }
  }
  dom.window.setTimeout = (callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback: () => { timers.delete(id); callback(); }, delay });
    return id;
  };
  dom.window.clearTimeout = (id) => timers.delete(id);
  const values = {
    window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver,
    fetch: (url, options) => {
      if (url.endsWith("/listHosts")) {
        assert.equal(options.body, "null");
        return Promise.resolve(rpcResponse([
          { id: "host-a", name: "Machine A", status: "connected" },
          { id: "host-b", name: "Machine B", status: "connected" },
        ]));
      }
      return fetcher(url, options);
    },
    EventSource: FakeEventSource,
  };
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const controller = new AbortController();
  const dispose = mountBalanceFooter({ pluginId: "vrata", generation: 1, signal: controller.signal });
  t.after(() => {
    dispose();
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { dom, controller, dispose, timers, sources, document: dom.window.document, select(hostId) {
    const selector = dom.window.document.querySelector("[data-vrata-balance] select");
    selector.value = hostId;
    selector.dispatchEvent(new dom.window.Event("change"));
  } };

}

const rpcResponse = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });

test("footer mounts in the lower sidebar, refreshes, follows remounts and cleans up", async (t) => {
  let calls = 0;
  let nextResult = balance;
  const ui = client(t, async (url, options) => {
    calls++;
    assert.equal(url, "/api/v1/plugins/vrata/rpc/balance");
    assert.deepEqual(JSON.parse(options.body), { hostId: "host-a" });
    assert.equal(options.headers.authorization, undefined);
    return rpcResponse(nextResult);
  });
  await settle();
  assert.equal(calls, 0);
  ui.sources[0].refresh();
  ui.dom.window.dispatchEvent(new ui.dom.window.Event("focus"));
  await settle();
  assert.equal(calls, 0);
  assert.equal(ui.timers.size, 0);
  ui.select("host-a");
  await settle();
  let row = ui.document.querySelector("[data-vrata-balance]");
  assert.equal(row.parentElement.firstElementChild, row);
  assert.equal(row.dataset.bbPlugin, "vrata");
  assert.equal(row.querySelector("button").textContent, "Врата AI1,50 ₽");
  assert.equal(row.querySelector("select").selectedOptions[0].textContent, "Machine A");
  assert.match(row.querySelector("button").title, /Всего \(включая резерв\): 1,50 ₽/);
  assert.match(row.querySelector("button").title, /Доступно: 1,30 ₽/);
  assert.match(row.querySelector("button").title, /Бонусы: 0,30 ₽/);
  assert.match(row.querySelector("button").title, /В резерве: 0,20 ₽/);
  const link = row.querySelector("a");
  assert.equal(link.href, "https://vrata.tg/bot");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(ui.sources[0].url, "/api/v1/plugins/vrata/http/balance-events");
  assert.equal([...ui.timers.values()][0].delay, 30_000);

  nextResult = { ...balance, spendable: "2400000" };
  row.querySelector("button").click();
  await settle();
  assert.match(row.textContent, /2,60 ₽/);
  ui.dom.window.dispatchEvent(new ui.dom.window.Event("focus"));
  await settle();
  [...ui.timers.values()][0].callback();
  await settle();
  assert.equal(calls, 4);

  ui.document.querySelector("aside").remove();
  await settle();
  const beforeOldClick = calls;
  row.querySelector("button").click();
  await settle();
  assert.equal(calls, beforeOldClick);
  ui.document.body.innerHTML = '<aside><div data-sidebar="footer"></div></aside><div data-sidebar="footer"></div>';
  await settle();
  assert.equal(ui.document.querySelectorAll("[data-vrata-balance]").length, 2);
  row = ui.document.querySelector("[data-vrata-balance]");
  assert.match(row.textContent, /2,60 ₽/);

  ui.controller.abort();
  ui.dispose();
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.sources[0].closed, true);
  assert.equal(ui.document.querySelectorAll("[data-vrata-balance]").length, 0);
  const before = calls;
  ui.dom.window.dispatchEvent(new ui.dom.window.Event("focus"));
  ui.dom.window.dispatchEvent(new ui.dom.window.Event("online"));
  ui.document.dispatchEvent(new ui.dom.window.Event("visibilitychange"));
  ui.document.body.innerHTML = '<div data-sidebar="footer"></div>';
  row.querySelector("button").click();
  ui.sources[0].refresh();
  await settle();
  assert.equal(calls, before);
  assert.equal(ui.document.querySelector("[data-vrata-balance]"), null);
});

test("missing key keeps the machine picker visible; failures replace the old balance and can recover", async (t) => {
  let nextResult = { status: "unconfigured" };
  const ui = client(t, async () => rpcResponse(nextResult));
  await settle();
  ui.select("host-a");
  await settle();
  const row = ui.document.querySelector("[data-vrata-balance]");
  assert.equal(row.hidden, false);
  assert.match(row.querySelector("button").textContent, /Ключ не настроен/);
  assert.equal(row.querySelector("select").value, "host-a");
  nextResult = balance;
  [...ui.timers.values()][0].callback();
  await settle();
  assert.equal(row.hidden, false);
  assert.match(row.textContent, /1,50 ₽/);
  nextResult = { status: "error", message: "Проверьте ключ API" };
  row.querySelector("button").click();
  await settle();
  assert.equal(row.querySelector("button").textContent, "Врата AIБаланс недоступен");
  assert.match(row.querySelector("button").title, /Проверьте ключ API/);
  nextResult = { status: "ok", spendable: "bad-data" };
  row.querySelector("button").click();
  await settle();
  assert.equal(row.querySelector("button").textContent, "Врата AIБаланс недоступен");
  nextResult = balance;
  row.querySelector("button").click();
  await settle();
  assert.match(row.textContent, /1,50 ₽/);
});

test("overlapping refreshes are coalesced and disposal aborts an in-flight request", async (t) => {
  let calls = 0;
  let requestSignal;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = client(t, async (_url, options) => {
    calls++;
    requestSignal = options.signal;
    await pending;
    return rpcResponse(balance);
  });
  await settle();
  ui.select("host-a");
  ui.dom.window.dispatchEvent(new ui.dom.window.Event("focus"));
  ui.sources[0].refresh();
  assert.equal(calls, 1);
  ui.dispose();
  assert.equal(requestSignal.aborted, true);
  finish();
  await settle();
  assert.equal(ui.document.querySelector("[data-vrata-balance]"), null);
});

test("a completed request refreshes immediately and restarts the 30-second fallback", async (t) => {
  let calls = 0;
  const ui = client(t, async () => { calls++; return rpcResponse(balance); });
  await settle();
  ui.select("host-a");
  await settle();
  const oldTimer = [...ui.timers.keys()][0];
  ui.sources[0].refresh();
  await settle();
  assert.equal(calls, 2);
  assert.equal(ui.timers.has(oldTimer), false);
  assert.equal(ui.timers.size, 1);
  assert.equal([...ui.timers.values()][0].delay, 30_000);
  [...ui.timers.values()][0].callback();
  await settle();
  assert.equal(calls, 3);
  assert.equal(ui.timers.size, 1);
});

test("a request completed during a balance fetch queues a fresh read instead of losing the update", async (t) => {
  let calls = 0;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const ui = client(t, async () => {
    calls++;
    if (calls === 1) { await pending; return rpcResponse(balance); }
    return rpcResponse({ ...balance, spendable: "1200000" });
  });
  await settle();
  ui.select("host-a");
  ui.sources[0].refresh();
  ui.sources[0].refresh();
  assert.equal(calls, 1);
  finish();
  await settle();
  assert.equal(calls, 2);
  assert.match(ui.document.querySelector("[data-vrata-balance]").textContent, /1,40 ₽/);
  assert.equal(ui.timers.size, 1);
});

test("backend signals only Vrata completions and failures; disconnect and reload close streams", async (t) => {
  const handlers = new Map();
  let route;
  let dispose;
  const notify = registerBalanceEvents({
    events: { on: (event, handler) => handlers.set(event, handler) },
    http: { route: (method, path, handler) => {
      assert.equal(method, "GET"); assert.equal(path, "/balance-events"); route = handler;
    } },
    onDispose: (handler) => { dispose = handler; },
  });
  t.after(() => dispose());
  const controller = new AbortController();
  const response = route({ req: { raw: new Request("http://bb.test", { signal: controller.signal }) } });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), "data: refresh\n\n");
  let received = false;
  const next = reader.read().then((value) => { received = true; return value; });
  handlers.get("thread.idle")({ thread: { providerId: "codex" } });
  handlers.get("thread.failed")({ thread: { providerId: "claude" } });
  await settle();
  assert.equal(received, false);
  handlers.get("thread.idle")({ thread: { providerId: "vrata" } });
  assert.equal(decoder.decode((await next).value), "data: refresh\n\n");
  handlers.get("thread.failed")({ thread: { providerId: "vrata" } });
  assert.equal(decoder.decode((await reader.read()).value), "data: refresh\n\n");
  notify();
  assert.equal(decoder.decode((await reader.read()).value), "data: refresh\n\n");
  controller.abort();
  assert.equal((await reader.read()).done, true);
  const cancelled = route({ req: { raw: new Request("http://bb.test") } });
  await cancelled.body.cancel();
  assert.doesNotThrow(() => handlers.get("thread.idle")({ thread: { providerId: "vrata" } }));
  const reconnected = route({ req: { raw: new Request("http://bb.test") } }).body.getReader();
  await reconnected.read();
  dispose();
  assert.equal((await reconnected.read()).done, true);
});


test("switching footer hosts aborts the old fetch and ignores its late balance and completion", async (t) => {
  const requests = [];
  const ui = client(t, (url, options) => new Promise((resolve, reject) => {
    requests.push({ hostId: JSON.parse(options.body).hostId, signal: options.signal, resolve, reject });
  }));
  await settle();
  ui.select("host-a");
  assert.equal(requests[0].hostId, "host-a");
  ui.sources[0].refresh(); // pending refresh for A must not transfer to B.
  ui.select("host-b");
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].hostId, "host-b");
  const row = ui.document.querySelector("[data-vrata-balance]");
  assert.equal(row.querySelector("select").selectedOptions[0].textContent, "Machine B");
  requests[0].resolve(rpcResponse({ ...balance, spendable: "9900000" }));
  await settle();
  assert.equal(row.querySelector("button").disabled, true);
  assert.equal(ui.timers.size, 0);
  assert.equal(row.textContent.includes("10,10 ₽"), false);
  requests[1].resolve(rpcResponse(balance));
  await settle();
  assert.match(row.querySelector("button").textContent, /1,50 ₽/);
  assert.equal(requests.length, 2);
  assert.equal(ui.sources.length, 1);
  assert.equal(ui.timers.size, 1);
  ui.select("host-a");
  assert.equal(row.textContent.includes("1,50 ₽"), false);
  ui.select("");
  assert.equal(requests[2].signal.aborted, true);
  requests[2].reject(new Error("late private failure"));
  await settle();
  assert.equal(row.querySelector("button").textContent, "Врата AIВыберите машину");
  assert.equal(ui.timers.size, 0);
  assert.equal(requests.length, 3);
});
