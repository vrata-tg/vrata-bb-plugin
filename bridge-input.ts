import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { formatDimensionNote, resizeImage } from "./image-runtime.js";

/** Only fixed, adapter-owned messages are safe to show in the thread. */
export class InputError extends Error {
  override name = "InputError";
}

function imageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const header = bytes.subarray(0, 6).toString("ascii");
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

async function loadLocalFile(path: string, cwd: string, signal: AbortSignal): Promise<Buffer> {
  try {
    const bytes = await readFile(resolve(cwd, path), { signal });
    signal.throwIfAborted();
    return bytes;
  } catch {
    signal.throwIfAborted();
    throw new InputError("Не удалось прочитать вложенный файл.");
  }
}

async function loadImageUrl(source: string, signal: AbortSignal): Promise<Buffer> {
  try {
    const url = new URL(source);
    if (!["data:", "http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new InputError("Изображение должно иметь data URL или HTTP(S) URL без имени пользователя и пароля.");
    }
    const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      signal.throwIfAborted();
      throw new InputError("Не удалось загрузить вложенное изображение.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof InputError) throw error;
    throw new InputError("Не удалось загрузить вложенное изображение.");
  }
}

function fileText(bytes: Buffer, mimeType?: string): string {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime && mime !== "application/octet-stream" && !mime.startsWith("text/") &&
      !/^application\/(?:json|.*\+json|xml|.*\+xml|javascript|x-javascript|typescript|x-typescript|x-sh|x-shellscript|yaml|x-yaml|toml)$/.test(mime)) {
    throw new InputError("Формат вложенного файла не поддерживается. Используйте текст UTF-8 или изображение PNG, JPEG, GIF, WebP.");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text) || text.startsWith("%PDF-")) {
      throw new Error("Binary file");
    }
    return text;
  } catch {
    throw new InputError("Вложенный файл не является текстом UTF-8 или поддерживаемым изображением.");
  }
}

async function imageContent(bytes: Buffer, modelImages: boolean, signal: AbortSignal): Promise<(TextContent | ImageContent)[]> {
  if (!modelImages) throw new InputError("Выбранная модель не поддерживает изображения.");
  const mimeType = imageMimeType(bytes);
  if (!mimeType) throw new InputError("Формат изображения не поддерживается. Используйте PNG, JPEG, GIF или WebP.");
  let resized;
  try {
    resized = await resizeImage(bytes, mimeType);
    signal.throwIfAborted();
  } catch {
    signal.throwIfAborted();
    throw new InputError("Не удалось обработать вложенное изображение.");
  }
  if (!resized) throw new InputError("Не удалось обработать вложенное изображение.");
  const content: (TextContent | ImageContent)[] = [{ type: "image", data: resized.data, mimeType: resized.mimeType }];
  const note = formatDimensionNote(resized);
  if (note) content.push({ type: "text", text: note });
  return content;
}

export async function buildUserMessage(
  input: readonly PromptInput[],
  cwd: string,
  modelImages: boolean,
  signal: AbortSignal,
): Promise<UserMessage> {
  signal.throwIfAborted();
  const content: (TextContent | ImageContent)[] = [];
  for (const block of input) {
    signal.throwIfAborted();
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
      case "localImage": {
        if (!modelImages) throw new InputError("Выбранная модель не поддерживает изображения.");
        const bytes = block.type === "image"
          ? await loadImageUrl(block.url, signal)
          : await loadLocalFile(block.path, cwd, signal);
        signal.throwIfAborted();
        const image = await imageContent(bytes, modelImages, signal);
        signal.throwIfAborted();
        content.push(...image);
        break;
      }
      case "localFile": {
        const bytes = await loadLocalFile(block.path, cwd, signal);
        signal.throwIfAborted();
        const label = `[File: ${JSON.stringify(block.name ?? block.path)}]\n`;
        if (imageMimeType(bytes)) {
          const image = await imageContent(bytes, modelImages, signal);
          signal.throwIfAborted();
          content.push({ type: "text", text: label }, ...image);
        } else {
          content.push({ type: "text", text: label + fileText(bytes, block.mimeType) });
        }
        break;
      }
      default:
        throw new InputError("Тип вложения не поддерживается.");
    }
  }
  signal.throwIfAborted();
  if (!content.some((block) => block.type === "image" || block.text.trim())) throw new InputError("Пустой запрос.");
  return { role: "user", content, timestamp: Date.now() };
}
