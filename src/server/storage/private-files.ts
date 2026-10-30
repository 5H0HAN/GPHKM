import "server-only";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

function rootPath() {
  if (process.env.NODE_ENV !== "development") throw new Error("Private object storage is not configured");
  const configured = process.env.GPHKM_PRIVATE_STORAGE_PATH?.trim();
  if (!configured) throw new Error("GPHKM_PRIVATE_STORAGE_PATH is required for local private files");
  if (!isAbsolute(configured)) throw new Error("GPHKM_PRIVATE_STORAGE_PATH must be absolute");
  const root = configured;
  const publicRoot = resolve(process.cwd(), "public");
  const publicPath = publicRoot + sep;
  if (root === publicRoot || root.startsWith(publicPath)) throw new Error("Private storage cannot be inside public");
  return root;
}

async function ensureRoot() {
  const root = rootPath();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await realpath(root);
  const publicRoot = resolve(process.cwd(), "public");
  const publicPath = publicRoot + sep;
  if (actual === publicRoot || actual.startsWith(publicPath)) throw new Error("Private storage cannot resolve inside public");
  await chmod(actual, 0o700);
  return actual;
}

function safeKey(key: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) throw new Error("Private file is unavailable");
  return key;
}

export async function savePrivateFile(bytes: Buffer) {
  if (bytes.length < 1) throw new Error("Private file is empty");
  const root = await ensureRoot();
  const key = randomUUID();
  const handle = await open(join(root, key), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(join(root, key), { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return key;
}

export async function readPrivateFile(key: string, maxBytes: number) {
  const root = await ensureRoot();
  const handle = await open(join(root, safeKey(key)), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error("Private file is unavailable");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function deletePrivateFile(key: string) {
  const root = await ensureRoot();
  const path = join(root, safeKey(key));
  const resolved = resolve(path);
  if (relative(root, resolved).startsWith("..")) throw new Error("Private file is unavailable");
  await rm(path, { force: true });
}
