
import { resolve, relative, dirname, basename } from "node:path";
import {
  writeFile,
  mkdir,
  lstat,
} from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";

import {
  resolveInside,
  assertRealPathInside,
  isSensitive,
} from "./safe-path";

export function createWriteFileTool(cwd: string) {
  return tool({
    description:
      "Create or overwrite a file in the project. Creates parent directories if they don't exist.",

    inputSchema: z.object({
      path: z.string().describe("Relative path to the file to write"),
      content: z.string().describe("The full content to write to the file"),
    }),

    execute: async ({ path, content }) => {
      try {
        // Resolve and validate the requested path.
        const resolved = resolveInside(cwd, path);

        // Create parent directories if they don't exist.
        await mkdir(dirname(resolved), { recursive: true });

        // Validate the real parent directory.
        const {
          realRoot,
          realFull: realParent,
        } = await assertRealPathInside(cwd, dirname(resolved));

        // Build the target path using the verified real parent.
        const realTarget = resolve(realParent, basename(resolved));

        // Check whether the target already exists.
        try {
          const stats = await lstat(resolved);

          // Reject symbolic links to prevent symlink-based writes.
          if (stats.isSymbolicLink()) {
            return {
              error: "Symbolic links are not allowed.",
            };
          }

          // Resolve and validate the existing target.
          const {
            realRoot: verifiedRoot,
            realFull,
          } = await assertRealPathInside(cwd, resolved);

          // Block sensitive files using the real path.
          if (isSensitive(verifiedRoot, realFull)) {
            return {
              error: "Writing to sensitive files is not allowed.",
            };
          }

          await writeFile(realFull, content, "utf-8");
        } catch (err) {
          // Only handle missing files here.
          if (
            !(err instanceof Error) ||
            !("code" in err) ||
            err.code !== "ENOENT"
          ) {
            throw err;
          }

          // Check the new file's real path for sensitive names.
          if (isSensitive(realRoot, realTarget)) {
            return {
              error: "Writing to sensitive files is not allowed.",
            };
          }

          await writeFile(realTarget, content, "utf-8");
        }

        return {
          success: true as const,
          path: relative(cwd, resolved),
          bytesWritten: Buffer.byteLength(content, "utf-8"),
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);

        return {
          error: `Failed to write file: ${message}`,
        };
      }
    },
  });
}
