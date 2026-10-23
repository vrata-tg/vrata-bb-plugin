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
  return { app, fireEvent, waitFor, mount(slot, props, options) {
    const view = renderSlot(slot, props, options);
    views.push(view);
    return view;
  } };
}

const hosts = [
  { id: "host-a", name: "Machine A", status: "connected" },
  { id: "host-b", name: "Machine B", status: "disconnected" },
];
const metadata = (hostId, configured = false) => ({ hostId, hostName: hostId === "host-a" ? "Machine A" : "Machine B", configured, baseUrl: `https://${hostId}.example` });
const interaction = (id = "a") => ({ id: `interaction-${id}`, threadId: `thread-${id}`, title: "Настройка", payload: null });

test("model onboarding consumes the real slot payload and submits a supported effort after a model switch", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const slot = app.pendingInteractions.find(({ id }) => id === "model");
  const submitted = [];
  const view = mount(slot, {
    interaction: {
      id: "interaction-model", threadId: "thread-model", title: "Choose model",
      payload: { models: [
        { id: "reasoning", name: "Reasoning", reasoningLevels: ["none", "high", "max"] },
        { id: "text", name: "Text", reasoningLevels: ["none"] },
      ] },
    },
    submit: async (value) => { submitted.push(value); },
  });
  const selectors = view.getAllByRole("combobox");
  assert.equal(selectors.length, 2);
  assert.deepEqual([...selectors[0].options].map(({ value }) => value), ["reasoning", "text"]);
  fireEvent.change(selectors[1], { target: { value: "max" } });
  fireEvent.click(view.getByRole("button"));
  await waitFor(() => assert.deepEqual(submitted[0], { modelId: "reasoning", reasoningLevel: "max" }));
  await waitFor(() => assert.equal(view.getByRole("button").disabled, false));
  fireEvent.change(selectors[0], { target: { value: "text" } });
  assert.equal(view.getAllByRole("combobox").length, 1);
  fireEvent.click(view.getByRole("button"));
  await waitFor(() => assert.deepEqual(submitted[1], { modelId: "text", reasoningLevel: "none" }));
});


test("thread onboarding saves opaque credentials and URL only to its target, then continues once", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const calls = [];
  const submitted = [];
  const saved = Promise.withResolvers();
  const view = mount(app.pendingInteractions.find(({ id }) => id === "api-key"), {
    interaction: interaction(), submit: async (value) => { submitted.push(value); },
  }, { rpc: {
    getConfiguration: async (input) => { calls.push(["get", input]); return metadata("host-a"); },
    saveCredentials: async (input) => { calls.push(["save", input]); return saved.promise; },
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Адрес API").value, "https://host-a.example"));
  assert.equal(view.getByLabelText("Ключ API").value, "");
  assert.ok(view.getByText("Machine A"));
  const key = " !$ENV-opaque-key ";
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: key } });
  fireEvent.change(view.getByLabelText("Адрес API"), { target: { value: "https://custom.example/v1" } });
  fireEvent.click(view.getByRole("button"));
  fireEvent.submit(view.container.querySelector("form"));
  assert.equal(calls.filter(([method]) => method === "save").length, 1);
  assert.equal(calls[1][1].apiKey === key, true);
  assert.deepEqual(calls[1][1].target, { kind: "thread", threadId: "thread-a" });
  assert.equal(calls[1][1].baseUrl, "https://custom.example/v1");
  assert.equal(submitted.length, 0);
  saved.resolve({ ...metadata("host-a", true), baseUrl: "https://custom.example/v1" });
  await waitFor(() => assert.deepEqual(submitted, [{ configured: true }]));
  assert.equal(view.queryByLabelText("Ключ API"), null);
  fireEvent.submit(view.container.querySelector("form"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted.length, 1);
  assert.deepEqual(calls.map(([method]) => method), ["get", "save"]);
});

test("closing onboarding ignores a late save and never continues the old interaction", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
  const saved = Promise.withResolvers();
  let submitted = 0;
  const view = mount(app.pendingInteractions.find(({ id }) => id === "api-key"), {
    interaction: interaction(), submit: async () => { submitted++; },
  }, { rpc: {
    getConfiguration: async () => metadata("host-a"),
    saveCredentials: async () => saved.promise,
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "synthetic-key" } });
  fireEvent.click(view.getByRole("button"));
  view.unmount();
  saved.resolve(metadata("host-a", true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, 0);
});

test("settings select the only connected machine, rotate and delete its local key without reading it back", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
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
  fireEvent.change(view.getByLabelText("Адрес API"), { target: { value: "https://rotate.example" } });
  fireEvent.click(view.getByRole("button", { name: "Сохранить ключ" }));
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").value, ""));
  assert.deepEqual(calls[1][1].target, { kind: "host", hostId: "host-a" });
  assert.equal(calls[1][1].apiKey === "$OPAQUE", true);
  assert.equal(calls[1][1].baseUrl, "https://rotate.example");
  fireEvent.click(view.getByRole("button", { name: "Удалить ключ" }));
  await waitFor(() => assert.equal(view.getByRole("status").textContent, "Ключ на этой машине не настроен"));
  assert.deepEqual(calls[2], ["delete", { hostId: "host-a" }]);
  assert.equal(view.getByRole("button", { name: "Удалить ключ" }).disabled, true);
  assert.equal(view.getByLabelText("Ключ API").value, "");
});

test("switching machines clears secrets and ignores late configuration, save and delete replies", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
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
    await waitFor(() => assert.equal(view.getByLabelText("Адрес API").value, "https://host-b.example"));
    assert.equal(view.getByLabelText("Ключ API").value, "");
    assert.equal(view.getByRole("status").textContent, "Ключ на этой машине не настроен");
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
  const { app, mount, fireEvent, waitFor } = await setup(t);
  let submitted = 0;
  const view = mount(app.pendingInteractions.find(({ id }) => id === "api-key"), {
    interaction: interaction(), submit: async () => { submitted++; },
  }, { rpc: {
    getConfiguration: async () => metadata("host-a"),
    saveCredentials: async () => { throw new Error("PRIVATE transport response with key"); },
  } });
  await waitFor(() => assert.equal(view.getByLabelText("Ключ API").disabled, false));
  fireEvent.change(view.getByLabelText("Ключ API"), { target: { value: "synthetic" } });
  fireEvent.click(view.getByRole("button"));
  await waitFor(() => assert.ok(view.getByRole("alert")));
  assert.equal(view.getByRole("alert").textContent.includes("PRIVATE"), false);
  assert.equal(submitted, 0);
});

test("setup page from balance selects its target and saves the key on that machine", async (t) => {
  const { app, mount, fireEvent, waitFor } = await setup(t);
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
  await waitFor(() => assert.equal(view.getByRole("status").textContent, "Ключ сохранён на этой машине"));
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
