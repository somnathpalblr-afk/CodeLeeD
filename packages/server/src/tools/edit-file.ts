import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import {
  assertRealPathInside,
  isSensitive,
  resolveInside,
  toDisplayPath,
} from "./safe-path";

const MAX_FILE_BYTES = 1_000_000;

// Start positions of matches, including overlapping ones. Stops after `limit`.
function findMatches(haystack: string, needle: string, limit = 2): number[] {
  const hits: number[] = [];
  let from = 0;
  while (hits.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    hits.push(index);
    from = index + 1;
  }
  return hits;
}

const toCrlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

export function createEditFileTool(cwd: string) {
  const root = path.resolve(cwd);

  return tool({
    description:
      "Make a targeted edit to an existing file by replacing an exact piece of text. oldString must appear exactly once in the file. Use this for small changes instead of rewriting whole files.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Path of the file, relative to the project folder"),
      oldString: z
        .string()
        .min(1)
        .describe("The exact text to find (must be unique in the file)"),
      newString: z.string().describe("The text to replace it with"),
    }),
    execute: async ({ path: filePath, oldString, newString }) => {
      try {
        const full = resolveInside(root, filePath);

        if (isSensitive(root, full)) {
          return { error: `Editing ${filePath} is not allowed.` };
        }
        if (oldString === newString) {
          return { error: "oldString and newString are identical, so nothing would change." };
        }

        // Check again on the real path, so a symlink can't reach a protected file.
        const { realRoot, realFull } = await assertRealPathInside(root, full);
        if (isSensitive(realRoot, realFull)) {
          return { error: `Editing ${filePath} is not allowed.` };
        }

        const info = await stat(full);
        if (!info.isFile()) return { error: `${filePath} is not a file.` };
        if (info.size > MAX_FILE_BYTES) {
          return { error: `${filePath} is too large to edit (over ${MAX_FILE_BYTES} bytes).` };
        }

        const content = await readFile(full, "utf8");
        if (content.includes("\0")) {
          return { error: `${filePath} looks like a binary file and cannot be edited.` };
        }

        // Try the text exactly as given first, then with CRLF line endings.
        const candidates = [{ oldText: oldString, newText: newString }];
        if (content.includes("\r\n")) {
          const converted = { oldText: toCrlf(oldString), newText: toCrlf(newString) };
          if (converted.oldText !== oldString) candidates.push(converted);
        }

        const chosen = candidates.find((c) => content.includes(c.oldText));
        if (!chosen) {
          return {
            error:
              "oldString was not found. Read the file again and copy the exact text, including spaces and indentation.",
          };
        }

        const hits = findMatches(content, chosen.oldText);
        if (hits.length > 1) {
          return {
            error:
              "oldString matches more than one place. Include more surrounding lines so it is unique.",
          };
        }

        const index = hits[0]!;
        // Slice instead of String.replace so "$&" or "$'" in newString stay literal.
        const updated =
          content.slice(0, index) +
          chosen.newText +
          content.slice(index + chosen.oldText.length);
        await writeFile(full, updated, "utf8");

        return {
          success: true as const,
          path: toDisplayPath(root, full),
          line: content.slice(0, index).split("\n").length,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to edit file: ${message}` };
      }
    },
  });
}