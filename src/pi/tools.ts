export const BB_PI_EXTENSION_SOURCE = String.raw`
import { readFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";

const CHILD_TO_BRIDGE_FD = 3;
const BRIDGE_TO_CHILD_FD = 4;

function writeLine(fd, message) {
  const line = JSON.stringify(message) + "\n";
  try {
    // Synchronous: tool results and checkpoint replies must never interleave.
    writeSyncAll(fd, line);
  } catch {
    // The bridge is gone; nothing to report to.
  }
}

function writeSyncAll(fd, text) {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/** Newline-only line reader (never readline: it splits on U+2028/U+2029). */
function readLines(input, onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (;;) {
      const index = text.indexOf("\n", start);
      if (index === -1) {
        pending += text.slice(start);
        return;
      }
      const line = pending + text.slice(start, index);
      pending = "";
      start = index + 1;
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });
}

// ---- the extension ----

export default function bbExtension(pi) {
  const toolsFile = process.env.PI_BB_TOOLS_FILE;
  const tools = toolsFile ? JSON.parse(readFileSync(toolsFile, "utf8")) : [];
  const pendingToolCalls = new Map();
  let nextId = 0;
  let sessionContext = null;

  // Non-blocking: libuv polls the pipe, so pi's process.exit is never held
  // up by an outstanding read; EOF (the bridge ended its writer) closes it.
  const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
  bridgeIn.on("error", () => undefined);
  bridgeIn.unref();
  readLines(bridgeIn, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.kind === "tool-result") {
      const pending = pendingToolCalls.get(message.id);
      if (!pending) return;
      pendingToolCalls.delete(message.id);
      pending.resolve({ content: message.content, details: { bbToolError: message.isError === true } });
      return;
    }
    if (message.kind === "request" && message.method === "leaf") {
      writeLine(CHILD_TO_BRIDGE_FD, {
        kind: "reply", id: message.id, result: { leafId: currentLeafId() },
      });
    }
  });

  function currentLeafId() {
    return sessionContext?.sessionManager?.getLeafId?.() ?? null;
  }

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_toolCallId, params, signal) {
        nextId += 1;
        const id = "tc-" + String(nextId);
        const result = new Promise((resolve, reject) => {
          pendingToolCalls.set(id, { resolve, reject });
        });
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              const pending = pendingToolCalls.get(id);
              if (!pending) return;
              pendingToolCalls.delete(id);
              pending.reject(new Error("Tool call aborted"));
            },
            { once: true },
          );
        }
        writeLine(CHILD_TO_BRIDGE_FD, {
          kind: "tool-call",
          id,
          toolName: tool.name,
          arguments: params ?? {},
        });
        return result;
      },
    });
  }

  // Throwing here would discard non-text blocks from failed BB tool results.
  pi.on("tool_result", (event) => {
    if (event.details?.bbToolError === true) return { isError: true };
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    // Pi's active-tool set is session state; a resumed or forked session can
    // predate the bb tools, so make sure every injected tool is active.
    if (tools.length > 0 && typeof pi.setActiveTools === "function") {
      const active = new Set(pi.getActiveTools?.() ?? []);
      let missing = false;
      for (const tool of tools) {
        if (!active.has(tool.name)) {
          active.add(tool.name);
          missing = true;
        }
      }
      if (missing) pi.setActiveTools([...active]);
    }
    writeLine(CHILD_TO_BRIDGE_FD, { kind: "ready" });
  });

  // The run's checkpoint, read in-process the moment the run ends: pi emits
  // this to extensions before it writes its own agent_end to stdout, and
  // before any continuation or compaction can move the leaf.
  pi.on("agent_end", async (_event, ctx) => {
    sessionContext = ctx ?? sessionContext;
    writeLine(CHILD_TO_BRIDGE_FD, { kind: "agent-end-leaf", leafId: currentLeafId() });
  });
}

`;
