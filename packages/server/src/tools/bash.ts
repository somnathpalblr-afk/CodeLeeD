import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

// First word -> allowed second words ("*" means any arguments).
const ALLOWED: Record<string, Set<string> | "*"> = {
  bun: new Set(["run", "test", "install", "add"]),
  npm: new Set(["run", "test", "install", "ci"]),
  pnpm: new Set(["run", "test", "install"]),
  git: new Set(["status", "diff", "log", "show", "branch", "rev-parse"]),
  tsc: "*",
};

const SECRET_KEY = /key|token|secret|password|credential|database_url|auth/i;

function safeEnv() {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_KEY.test(name)) env[name] = value;
  }
  env.TERM = "dumb";
  return env;
}

// Split into arguments, honoring "double" and 'single' quotes. No shell syntax.
function tokenize(input: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }

  if (quote) return null; // unclosed quote
  if (started) args.push(current);
  return args;
}

function checkAllowed(args: string[]): string | null {
  const [program, sub] = args;
  if (!program) return "Empty command.";

  const rule = ALLOWED[program];
  if (!rule) {
    return `"${program}" is not allowed. Allowed programs: ${Object.keys(ALLOWED).join(", ")}.`;
  }
  if (rule !== "*" && (!sub || !rule.has(sub))) {
    return `"${program} ${sub ?? ""}" is not allowed. Allowed: ${[...rule].map((s) => `${program} ${s}`).join(", ")}.`;
  }
  if (args.some((a) => a.startsWith("--output"))) {
    return "Output-redirecting flags are not allowed.";
  }
  return null;
}

function truncate(text: string) {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n... (truncated, ${text.length} characters total)`
    : text;
}

export function createBashTool(cwd: string) {
  return tool({
    description:
      "Run a command in the project folder for tests, builds, installs and read-only git. No shell: pipes, &&, redirects and variables do not work. Only specific commands are allowed (for example: bun test, bun run build, git status, git diff).",
    inputSchema: z.object({
      command: z.string().min(1).describe("The command to run, for example: bun test"),
      timeout: z
        .number()
        .int()
        .min(1_000)
        .max(MAX_TIMEOUT)
        .default(DEFAULT_TIMEOUT)
        .describe("Timeout in milliseconds (default 30000, max 120000)"),
    }),
    execute: async ({ command, timeout }, { abortSignal }) => {
      if (/[\r\n]/.test(command)) return { error: "Multi-line commands are not allowed." };

      const args = tokenize(command);
      if (!args) return { error: "Unclosed quote in command." };

      const denied = checkAllowed(args);
      if (denied) return { error: denied };

      try {
        const proc = Bun.spawn(args, {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: safeEnv(),
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeout);
        const onAbort = () => proc.kill();
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        try {
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          const exitCode = await proc.exited;

          return {
            exitCode,
            timedOut,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
          };
        } finally {
          clearTimeout(timer);
          abortSignal?.removeEventListener("abort", onAbort);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to run command: ${message}` };
      }
    },
  });
}