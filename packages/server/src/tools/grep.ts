import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import {
  resolveInside,
  assertRealPathInside,
  isSensitive,
  toDisplayPath,
} from "./safe-path";

const MAX_MATCHES = 50;
const MAX_FILES_SCANNED = 5_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_LENGTH = 1_000; // skip minified or huge lines
const MAX_DISPLAY_LENGTH = 300;
const TIME_BUDGET_MS = 10_000;

type Match = { file: string; line: number; content: string };

export function createGrepTool(cwd: string) {
  return tool({
    description:
      "Search file contents using a JavaScript regular expression. Returns matching lines with file paths and line numbers. Skips hidden files and directories, node_modules, sensitive files, and binary files.",
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .describe("Regex pattern to search for (JavaScript syntax)"),
      path: z
        .string()
        .describe("Relative directory to search in (defaults to project root)")
        .default("."),
      include: z
        .string()
        .describe("Glob pattern to filter files (e.g. '*.ts', '*.{ts,tsx}')")
        .optional(),
    }),
    execute: async ({ pattern, path, include }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Invalid regular expression: ${message}` };
      }

      try {
        const searchDir = resolveInside(cwd, path);

        if (isSensitive(cwd, searchDir)) {
          return { error: "Searching this directory is not allowed." };
        }

        // Follow symlinks and verify the real directory is inside the project.
        await assertRealPathInside(cwd, searchDir);

        const info = await stat(searchDir);
        if (!info.isDirectory()) {
          return { error: "Path is not a directory." };
        }

        // Like grep --include: a pattern without a slash matches in any folder.
        const filePattern = include
          ? include.includes("/")
            ? include
            : `**/${include}`
          : "**/*";

        const glob = new Bun.Glob(filePattern);
        const matches: Match[] = [];
        let truncated = false;
        let scanned = 0;
        const deadline = Date.now() + TIME_BUDGET_MS;

        scan: for await (const relativeMatch of glob.scan({
          cwd: searchDir,
          dot: false,
          onlyFiles: true,
          followSymlinks: false,
        })) {
          if (scanned >= MAX_FILES_SCANNED || Date.now() > deadline) {
            truncated = true;
            break;
          }
          scanned++;

          const absolute = resolve(searchDir, relativeMatch);

          // Patterns like "../**" must not escape the project folder.
          try {
            resolveInside(cwd, absolute);
          } catch {
            continue;
          }

          if (isSensitive(cwd, absolute)) continue;

          // Check where the file really lives before reading it.
          let real: { realRoot: string; realFull: string };
          try {
            real = await assertRealPathInside(cwd, absolute);
          } catch {
            continue;
          }
          if (isSensitive(real.realRoot, real.realFull)) continue;

          const file = Bun.file(real.realFull);
          if (file.size > MAX_FILE_BYTES) continue;

          const text = await file.text().catch(() => null);
          if (text === null || text.includes("\0")) continue; // unreadable or binary

          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.length > MAX_LINE_LENGTH) continue;
            if (!regex.test(line)) continue;

            if (matches.length >= MAX_MATCHES) {
              truncated = true;
              break scan;
            }

            matches.push({
              file: toDisplayPath(cwd, absolute),
              line: i + 1,
              content:
                line.length > MAX_DISPLAY_LENGTH
                  ? `${line.slice(0, MAX_DISPLAY_LENGTH)}…`
                  : line,
            });
          }
        }

        if (matches.length === 0 && !truncated) {
          return { matches: [], message: "No matches found" };
        }

        return {
          matches,
          ...(truncated ? { truncated: true } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to search files: ${message}` };
      }
    },
  });
}