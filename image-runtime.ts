import { createReadTool, formatDimensionNote } from "@earendil-works/pi-coding-agent";
import { resizeImageInProcess as resizeImage } from "#vrata-image-runtime";

export { resizeImage, formatDimensionNote };

export function createImageReadTool(cwd: string): ReturnType<typeof createReadTool> {
  const read = createReadTool(cwd, { autoResizeImages: false });
  return {
    ...read,
    async execute(id, params, signal, onUpdate) {
      signal?.throwIfAborted();
      const result = await read.execute(id, params, signal, onUpdate);
      signal?.throwIfAborted();
      const content: typeof result.content = [];
      for (const part of result.content) {
        if (part.type !== "image") {
          if (part.text.startsWith("Read image file [") && part.text.includes("\n[Image omitted:")) {
            throw new Error("Не удалось обработать изображение.");
          }
          content.push(part);
          continue;
        }
        signal?.throwIfAborted();
        const resized = await resizeImage(Buffer.from(part.data, "base64"), part.mimeType);
        signal?.throwIfAborted();
        if (!resized) throw new Error("Не удалось обработать изображение.");
        content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
        const note = formatDimensionNote(resized);
        if (note) content.push({ type: "text", text: note });
      }
      return { ...result, content };
    },
  };
}
