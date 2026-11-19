import { open, stat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";

import {
  resolveInside,
  assertRealPathInside,
  isSensitive,
} from "./safe-path";

const MAX_FILE_SIZE = 10_000; // characters returned to the model

export function createReadFileTool(cwd: string) {
  return tool({
    description:
      "Read the contents of a file in the project. Returns the file text, truncated if very large.",

    inputSchema: z.object({
      path: z.string().describe("Relative path to the file to read"),
    }),

    execute: async ({ path }) => {
      try {
        // Resolve and validate the requested path.
        const resolved = resolveInside(cwd, path);

        if (isSensitive(cwd, resolved)) {
          return { error: "Reading sensitive files is not allowed." };
        }

        // Resolve symlinks and verify the actual filesystem path.
        const { realRoot, realFull } = await assertRealPathInside(cwd, resolved);

        // Check sensitive files using the real filesystem path too.
        if (isSensitive(realRoot, realFull)) {
          return { error: "Reading sensitive files is not allowed." };
        }

        const info = await stat(realFull);
        if (!info.isFile()) {
          return { error: "Path is not a file. Use the directory listing tool instead." };
        }

        // Read only the first chunk, so large files never load fully into memory.
        const handle = await open(realFull, "r");
        let buffer: Buffer;
        try {
          buffer = Buffer.alloc(Math.min(info.size, MAX_FILE_SIZE * 4));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          buffer = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }

        // A null byte means binary data, which is useless as text.
        if (buffer.includes(0)) {
          return { error: "This looks like a binary file, so it was not read." };
        }

        const text = buffer.toString("utf-8");
        const truncated = info.size > buffer.length || text.length > MAX_FILE_SIZE;

        if (truncated) {
          return {
            content: text.slice(0, MAX_FILE_SIZE),
            truncated: true,
            totalBytes: info.size,
          };
        }

        return { content: text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${message}` };
      }
    },
  });
}