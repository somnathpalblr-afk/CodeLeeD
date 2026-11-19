import { realpath } from "node:fs/promises";
import path from "node:path";

const BLOCKED_SEGMENTS = new Set([".git", "node_modules"]);
const WRITE_BLOCKED_SEGMENTS = new Set(["dist", "generated", ".next"]);
const BLOCKED_NAMES = new Set([".npmrc", ".netrc", "id_rsa", "id_ed25519"]);
const BLOCKED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const ENV_ALLOWED = new Set([".env.example", ".env.sample", ".env.template"]);

function isOutside(rel: string) {
  return (
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  );
}

export function resolveInside(root: string, requested: string): string {
  const full = path.resolve(root, requested);

  if (isOutside(path.relative(root, full))) {
    throw new Error(`Path is outside the project folder: ${requested}`);
  }

  return full;
}

export function isSensitive(root: string, full: string): boolean {
  const rel = path.relative(root, full);

  const segments = rel.split(path.sep).map((s) => s.toLowerCase());

  if (segments.some((s) => BLOCKED_SEGMENTS.has(s))) {
    return true;
  }

  const base = path.basename(full).toLowerCase();

  if (ENV_ALLOWED.has(base)) {
    return false;
  }

  return (
    base.startsWith(".env") ||
    BLOCKED_NAMES.has(base) ||
    BLOCKED_EXTENSIONS.some((ext) => base.endsWith(ext))
  );
}

// Like realpath, but works for files that don't exist yet:
// it resolves the nearest existing parent and re-attaches the missing part.
async function realpathAllowMissing(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;

  while (true) {
    try {
      const real = await realpath(current);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Path could not be resolved");
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export async function assertRealPathInside(root: string, full: string) {
  const [realRoot, realFull] = await Promise.all([
    realpath(root),
    realpathAllowMissing(full),
  ]);

  if (isOutside(path.relative(realRoot, realFull))) {
    throw new Error("Path resolves outside the project folder.");
  }

  return { realRoot, realFull };
}

export function toDisplayPath(root: string, full: string) {
  return path.relative(root, full).split(path.sep).join("/");
}

// One call that does every check. Use this in each tool.
export async function resolveSafePath(
  root: string,
  requested: string,
  options: { write?: boolean } = {},
): Promise<string> {
  const full = resolveInside(root, requested);

  if (isSensitive(root, full)) {
    throw new Error(`Access to this file is not allowed: ${requested}`);
  }

  if (options.write) {
    const segments = path
      .relative(root, full)
      .split(path.sep)
      .map((s) => s.toLowerCase());
    if (segments.some((s) => WRITE_BLOCKED_SEGMENTS.has(s))) {
      throw new Error(`Writing to this location is not allowed: ${requested}`);
    }
  }

  // Follow symlinks, then check the real target again.
  const { realRoot, realFull } = await assertRealPathInside(root, full);

  if (isSensitive(realRoot, realFull)) {
    throw new Error(`Access to this file is not allowed: ${requested}`);
  }

  return full;
}