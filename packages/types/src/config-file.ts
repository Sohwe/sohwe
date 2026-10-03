import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { ConfigPathSchema } from "./index";
import { parseSohweConfig, type SohweConfig } from "./config";

export async function loadSohweConfig(root: string, path: string, required: boolean): Promise<SohweConfig | null> {
  ConfigPathSchema.parse(path);
  const target = resolve(root, path);
  let info;
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return null;
    throw new Error(`${path}:1:1: Config file could not be read`);
  }
  try { info = await stat(target); }
  catch { throw new Error(`${path}:1:1: Config file could not be read`); }
  if (!info.isFile()) throw new Error(`${path}:1:1: Config path is not a file`);
  if (info.size > 64 * 1024) throw new Error(`${path}:1:1: Config file exceeds 64 KiB`);
  const actual = await realpath(target);
  const rootActual = await realpath(root);
  const fromRoot = relative(rootActual, actual);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error(`${path}:1:1: Config path leaves the repository`);
  return parseSohweConfig(await readFile(actual, "utf8"), path);
}
