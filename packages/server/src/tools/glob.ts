import { resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";

import {
  resolveInside,
  assertRealPathInside,
  isSensitive,
  toDisplayPath,
} from "./safe-path";

const MAX_RESULTS = 200;

export function createGlobTool(cwd: string) {
  return tool({
    description:
      "Find files matching a glob pattern. Returns file paths relative to the project root. Skips node_modules, .git, hidden files and sensitive files.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe("Glob pattern to match (e.g. '**/*.ts', 'src/**/*.tsx')"),
      path: z
        .string()
        .describe("Relative directory to search in (defaults to project root)")
        .default("."),
    }),
    execute: async ({ pattern, path }) => {
      try {
        const searchDir = resolveInside(cwd, path);

        if (isSensitive(cwd, searchDir)) {
          return { error: "Searching this directory is not allowed." };
        }

        // Follow symlinks and verify the real directory is inside the project.
        await assertRealPathInside(cwd, searchDir);

        const glob = new Bun.Glob(pattern);
        const files: string[] = [];
        let truncated = false;

        for await (const match of glob.scan({
          cwd: searchDir,
          dot: false,
          onlyFiles: true,
          followSymlinks: false,
        })) {
          const absolute = resolve(searchDir, match);

          // Patterns like "../**" must not escape the project folder.
          try {
            resolveInside(cwd, absolute);
          } catch {
            continue;
          }

          if (isSensitive(cwd, absolute)) continue;

          if (files.length >= MAX_RESULTS) {
            truncated = true;
            break;
          }

          files.push(toDisplayPath(cwd, absolute));
        }

        files.sort();

        return {
          files,
          ...(truncated ? { truncated: true } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to search for files: ${message}` };
      }
    },
  });
}