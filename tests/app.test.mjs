import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

async function setup(t) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  const views = [];
  const previous = new Map();
  for (const name of ["window", "document", "navigator", "HTMLElement", "Event", "MutationObserver"]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
  }
  t.after(async () => {
    for (const view of views) view.unmount();
    await new Promise((resolve) => setImmediate(resolve));
    dom.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const app = await loadPluginApp(() => import("../dist/tests/app.js"));
  const mount = (slot, props, options) => {
    const view = renderSlot(slot, props, options);
    views.push(view);
    return view;
  };
  return { app, fireEvent, waitFor, mount,
    mountThread(kind, { interaction, submit }, options = {}) {
      return mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: `thread/${interaction.threadId}/${interaction.id}` }, { rpc: {
        ...options.rpc,
        getSetupInteraction: async () => ({ id: interaction.id, kind, data: interaction.payload }),
        submitSetupInteraction: async ({ answer }) => { const { kind, ...value } = answer; await submit(value); return null; },
      } });
    } };
}

const hosts = [
  { id: "host-a", name: "Machine A", status: "connected" },
  { id: "host-b", name: "Machine B", status: "disconnected" },
];
const metadata = (hostId, configured = false) => ({ hostId, hostName: hostId === "host-a" ? "Machine A" : "Machine B", configured, baseUrl: `https://${hostId}.example` });
const interaction = (id = "a") => ({ id: `interaction-${id}`, threadId: `thread-${id}`, title: "Настройка", payload: null });

test("model onboarding consumes the real slot payload and submits a supported effort after a model switch", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  const submitted = [];
  const view = mountThread("model", {
    interaction: {
      id: "interaction-model", threadId: "thread-model", title: "Choose model",
      payload: { models: [
        { id: "reasoning", name: "Reasoning", reasoningLevels: ["none", "high", "max"] },
        { id: "text", name: "Text", reasoningLevels: ["none"] },
      ] },
    },
    submit: async (value) => { submitted.push(value); },
  });
  await waitFor(() => assert.equal(view.getAllByRole("combobox").length, 2));
  const selectors = view.getAllByRole("combobox");
  assert.equal(selectors.length, 2);
  assert.deepEqual([...selectors[0].options].map(({ value }) => value), ["reasoning", "text"]);
  fireEvent.change(selectors[1], { target: { value: "max" } });
  fireEvent.click(view.getByRole("button", { name: "Продолжить запрос" }));
  await waitFor(() => assert.deepEqual(submitted[0], { modelId: "reasoning", reasoningLevel: "max" }));
  await waitFor(() => assert.equal(view.getByRole("button", { name: "Продолжить запрос" }).disabled, false));
  fireEvent.change(selectors[0], { target: { value: "text" } });
  assert.equal(view.getAllByRole("combobox").length, 1);
  fireEvent.click(view.getByRole("button", { name: "Продолжить запрос" }));
  await waitFor(() => assert.deepEqual(submitted[1], { modelId: "text", reasoningLevel: "none" }));
});


test("thread onboarding saves opaque credentials and URL only to its target, then continues once", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  const calls = [];
  const submitted = [];
  const saved = Promise.withResolvers();
  const view = mountThread("api-key", {
    interaction: interaction(), submit: async (value) => { submitted.push(value); },
  }, { rpc: {
    getConfiguration: async (input) => { calls.push(["get", input]); return metadata("host-a"); },
    saveCredentials: async (input) => { calls.push(["save", input]); return saved.promise; },
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  assert.equal(view.getByLabelText("Ключ API").value, "");
  assert.equal(view.queryByText("Machine A"), null);
  assert.equal(view.queryByLabelText("Адрес API"), null);
  const key = " !$ENV-opaque-key ";
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: key } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ и продолжить" }));
  fireEvent.submit(view.container.querySelector("form"));
  assert.equal(calls.filter(([method]) => method === "save").length, 1);
  assert.equal(calls[1][1].apiKey === key, true);
  assert.deepEqual(calls[1][1].target, { kind: "thread", threadId: "thread-a" });
  assert.equal(calls[1][1].baseUrl, "https://host-a.example");
  assert.equal(submitted.length, 0);
  saved.resolve({ ...metadata("host-a", true), baseUrl: "https://host-a.example" });
  await waitFor(() => assert.deepEqual(submitted, [{ configured: true }]));
  assert.equal(view.queryByLabelText("Ключ API"), null);
  fireEvent.submit(view.container.querySelector("form"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted.length, 1);
  assert.deepEqual(calls.map(([method]) => method), ["get", "save"]);
});

test("closing onboarding ignores a late save and never continues the old interaction", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  const saved = Promise.withResolvers();
  let submitted = 0;
  const view = mountThread("api-key", {
    interaction: interaction(), submit: async () => { submitted++; },
  }, { rpc: {
    getConfiguration: async () => metadata("host-a"),
    saveCredentials: async () => saved.promise,
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "synthetic-key" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ и продолжить" }));
  view.unmount();
  saved.resolve(metadata("host-a", true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, 0);
});

test("settings select the only connected machine, rotate and delete its local key without reading it back", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  let opened = 0;
  app.sidebarFooterActions.find(({ id }) => id === "settings").run({ openSettings: () => { opened++; } });
  assert.equal(opened, 1);
  const calls = [];
  const view = mount(app.settingsSections.find(({ id }) => id === "machine-auth"), {}, { rpc: {
    listHosts: async () => hosts,
    getConfiguration: async ({ target }) => { calls.push(["get", target]); return metadata(target.hostId, true); },
    saveCredentials: async (input) => { calls.push(["save", input]); return { ...metadata(input.target.hostId, true), baseUrl: input.baseUrl }; },
    deleteCredentials: async (input) => { calls.push(["delete", input]); return metadata(input.hostId); },
  } });
  await waitFor(() => assert.equal(view.getByRole("combobox").options.length, 3));
  assert.equal(view.getByRole("combobox").value, "host-a");
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  assert.equal(view.getByLabelText("Ключ API").value, "");
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "$OPAQUE" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ" }));
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").value, ""));
  assert.deepEqual(calls[1][1].target, { kind: "host", hostId: "host-a" });
  assert.equal(calls[1][1].apiKey === "$OPAQUE", true);
  assert.equal(calls[1][1].baseUrl, "https://host-a.example");
  fireEvent.click(view.getByRole("button", { name: "Удалить ключ" }));
  await waitFor(() => assert.equal(view.getByRole("status").textContent, "Добавьте ключ, чтобы начать"));
  assert.deepEqual(calls[2], ["delete", { hostId: "host-a" }]);
  assert.equal(view.queryByRole("button", { name: "Удалить ключ" }), null);
  assert.equal(view.getByLabelText("Ключ API").value, "");
});

test("switching machines clears secrets and ignores late configuration, save and delete replies", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  const loading = Promise.withResolvers();
  const saving = Promise.withResolvers();
  const deleting = Promise.withResolvers();
  let aReads = 0;
  const view = mount(app.settingsSections.find(({ id }) => id === "machine-auth"), {}, { rpc: {
    listHosts: async () => hosts.map((host) => ({ ...host, status: "connected" })),
    getConfiguration: async ({ target }) => target.hostId === "host-a" && ++aReads === 1 ? loading.promise : metadata(target.hostId, target.hostId === "host-a"),
    saveCredentials: async () => saving.promise,
    deleteCredentials: async () => deleting.promise,
  } });
  await waitFor(() => assert.equal(view.getByRole("combobox").options.length, 3));
  const select = (value) => fireEvent.change(view.getByRole("combobox"), { target: { value } });
  const expectB = async () => {
    await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
    assert.equal(view.getByLabelText("Ключ API").value, "");
    assert.equal(view.getByRole("status").textContent, "Добавьте ключ, чтобы начать");
    assert.equal(view.queryByRole("alert"), null);
  };
  select("host-a"); select("host-b");
  await expectB();
  loading.resolve(metadata("host-a", true));
  await new Promise((resolve) => setImmediate(resolve));
  await expectB();
  select("host-a");
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "private-draft" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ" }));
  select("host-b");
  await expectB();
  saving.resolve({ ...metadata("host-a", true), baseUrl: "https://late.example" });
  await new Promise((resolve) => setImmediate(resolve));
  await expectB();
  select("host-a");
  await waitFor(() => assert.equal(view.getByRole("button", { name: "Удалить ключ" }).disabled, false));
  fireEvent.click(view.getByRole("button", { name: "Удалить ключ" }));
  select("host-b");
  await expectB();
  deleting.reject(new Error("private transport detail"));
  await new Promise((resolve) => setImmediate(resolve));
  await expectB();
});

test("credential failure uses a safe message and cannot continue onboarding", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  let submitted = 0;
  const view = mountThread("api-key", {
    interaction: interaction(), submit: async () => { submitted++; },
  }, { rpc: {
    getConfiguration: async () => metadata("host-a"),
    saveCredentials: async () => { throw new Error("PRIVATE transport response with key"); },
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "synthetic" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ и продолжить" }));
  await waitFor(() => assert.ok(view.getByRole("alert")));
  assert.equal(view.getByRole("alert").textContent.includes("PRIVATE"), false);
  assert.equal(submitted, 0);
});

test("setup page from balance selects its target and saves the key on that machine", async (t) => {
  const { app, mount, mountThread, fireEvent, waitFor } = await setup(t);
  const calls = [];
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "host-b" }, { rpc: {
    listHosts: async () => hosts,
    getConfiguration: async ({ target }) => { calls.push(["get", target]); return metadata(target.hostId); },
    saveCredentials: async (input) => { calls.push(["save", input]); return metadata(input.target.hostId, true); },
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  assert.equal(view.getByRole("combobox").value, "host-b");
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "synthetic-setup" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ" }));
  await waitFor(() => assert.equal(view.getByRole("status").textContent, "Врата AI подключена"));
  assert.deepEqual(calls.map(([method, input]) => [method, method === "get" ? input : input.target]), [
    ["get", { kind: "host", hostId: "host-b" }], ["save", { kind: "host", hostId: "host-b" }],
  ]);
  assert.equal(view.getByLabelText("Ключ API").value, "");
});

test("setup without a target asks which machine when several are connected", async (t) => {
  const { app, mount, waitFor } = await setup(t);
  let reads = 0;
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "" }, { rpc: {
    listHosts: async () => hosts.map((host) => ({ ...host, status: "connected" })),
    getConfiguration: async () => { reads++; return metadata("host-a"); },
  } });
  await waitFor(() => assert.equal(view.getByRole("combobox").options.length, 3));
  assert.equal(view.getByRole("combobox").value, "");
  assert.equal(view.queryByLabelText("Ключ API"), null);
  assert.equal(reads, 0);
});

test("pending key and model slots navigate to the full setup page without rendering forms", async (t) => {
  const { app, mount, waitFor } = await setup(t);
  for (const kind of ["api-key", "model"]) {
    const view = mount(app.pendingInteractions.find(({ id }) => id === kind), { interaction: interaction(), submit: async () => {} });
    await waitFor(() => assert.deepEqual(view.navigateCalls[0], { method: "toPluginPanel", path: "setup", options: { subPath: "thread/thread-a/interaction-a", replace: true } }));
    assert.equal(view.container.querySelector("form"), null);
    view.unmount();
  }
});

test("one computer needs only a key, preserves its URL and puts the bot link first", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const writes = [];
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "" }, { rpc: {
    listHosts: async () => [{ id: "host-a", name: "f4d35e0fc025", status: "connected" }],
    getConfiguration: async () => metadata("host-a"),
    saveCredentials: async (input) => { writes.push(input); return metadata("host-a", true); },
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  assert.equal(view.queryByRole("combobox"), null);
  assert.equal(view.queryByLabelText("Адрес API"), null);
  assert.doesNotMatch(view.container.textContent, /f4d35e0fc025|Machine A|машин|компьютер/i);
  const input = view.getByLabelText("Ключ API");
  assert.ok(view.getByRole("link").compareDocumentPosition(input) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  fireEvent.change(input, { target: { value: "synthetic-key" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ" }));
  await waitFor(() => assert.equal(writes.length, 1));
  assert.equal(writes[0].baseUrl, "https://host-a.example");
});

test("setup page cancellation returns to its thread, while a late response never redirects after leaving", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const replies = [];
  const pending = Promise.withResolvers();
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "thread/thread-a/interaction-a" }, { rpc: {
    getSetupInteraction: async () => ({ id: "interaction-a", kind: "model", data: { models: [{ id: "m", name: "M", reasoningLevels: ["none"] }] } }),
    submitSetupInteraction: async (input) => { replies.push(input); return pending.promise; },
  } });
  await waitFor(() => assert.ok(view.queryByRole("button", { name: "Отмена" })));
  fireEvent.click(view.getByRole("button", { name: "Отмена" }));
  await waitFor(() => assert.equal(replies.length, 1));
  assert.deepEqual(replies[0], { threadId: "thread-a", interactionId: "interaction-a", answer: { kind: "cancel" } });
  view.unmount();
  pending.resolve(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.navigateCalls.length, 0);
});

test("cancelling setup stops the request and returns to its thread", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const answers = [];
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "thread/thread-a/interaction-a" }, { rpc: {
    getSetupInteraction: async () => ({ id: "interaction-a", kind: "api-key", data: {} }),
    getConfiguration: async () => metadata("host-a"),
    submitSetupInteraction: async ({ answer }) => { answers.push(answer); return null; },
  } });
  await waitFor(() => assert.ok(view.queryByRole("button", { name: "Отмена" })));
  fireEvent.click(view.getByRole("button", { name: "Отмена" }));
  await waitFor(() => assert.deepEqual(view.navigateCalls, [{ method: "toThread", threadId: "thread-a" }]));
  assert.deepEqual(answers, [{ kind: "cancel" }]);
});

test("multiple computers replace hash names with readable labels without duplicating the selected name", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "" }, { rpc: {
    listHosts: async () => [
      { id: "host-a", name: "f4d35e0fc025", status: "connected" },
      { id: "host-b", name: "My laptop", status: "connected" },
    ],
    getConfiguration: async () => metadata("host-a"),
  } });
  await waitFor(() => assert.equal(view.getByRole("combobox").options.length, 3));
  assert.equal(view.getByRole("combobox").options[1].textContent, "Компьютер 1");
  assert.equal(view.getByRole("combobox").options[2].textContent, "My laptop");
  fireEvent.change(view.getByRole("combobox"), { target: { value: "host-a" } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  assert.doesNotMatch(view.container.textContent, /f4d35e0fc025|Machine A/);
});

test("a sole offline computer reports the connection failure instead of leaving an empty setup page", async (t) => {
  const { app, mount, waitFor } = await setup(t);
  let reads = 0;
  const view = mount(app.navPanels.find(({ id }) => id === "setup"), { subPath: "" }, { rpc: {
    listHosts: async () => [{ id: "host-a", name: "f4d35e0fc025", status: "disconnected" }],
    getConfiguration: async () => { reads++; throw new Error("offline"); },
  } });
  await waitFor(() => assert.ok(view.queryByRole("alert")));
  assert.equal(reads, 1);
  assert.equal(view.queryByRole("combobox"), null);
  assert.doesNotMatch(view.container.textContent, /f4d35e0fc025/);
});
