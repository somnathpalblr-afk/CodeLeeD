import path from "node:path";
import type { Mode } from "@CodeLeeD/database/enums";
import { createReadFileTool } from "./read-file";
import { createListDirectoryTool } from "./list-directory";
import { createWriteFileTool } from "./write-file";
import { createEditFileTool } from "./edit-file";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createBashTool } from "./bash";

// bash can run any command on this PC and bypasses the path checks.
// It stays off unless you set ENABLE_BASH_TOOL=1 in .env.
const BASH_ENABLED = process.env.ENABLE_BASH_TOOL === "1";

export function createTools(cwd: string, mode: Mode) {
  // An absolute, normalized root keeps every path check consistent.
  const root = path.resolve(cwd);

  const readOnlyTools = {
    readFile: createReadFileTool(root),
    listDirectory: createListDirectoryTool(root),
    grep: createGrepTool(root),
    glob: createGlobTool(root),
  };

  if (mode === "PLAN") {
    return readOnlyTools;
  }

  return {
    ...readOnlyTools,
    writeFile: createWriteFileTool(root),
    editFile: createEditFileTool(root),
    ...(BASH_ENABLED ? { bash: createBashTool(root) } : {}),
  };
}