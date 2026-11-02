import "server-only";
import { constants } from "node:fs";
import { chmod, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readBoundedObjectBody } from "./bounded-object-body.ts";

const MAX_PRIVATE_FILE_BYTES = 10 * 1024 * 1024;
const R2_REQUEST_TIMEOUT_MS = 30_000;

type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

let r2Client: S3Client | null = null;
let r2Bucket: string | null = null;

function driver() {
  const configured = process.env.GPHKM_PRIVATE_STORAGE_DRIVER?.trim();
  const selected = configured || (process.env.NODE_ENV === "development" ? "filesystem" : "");
  if (selected === "filesystem") {
    if (process.env.NODE_ENV !== "development") throw new Error("Filesystem private storage is development-only");
    return "filesystem" as const;
  }
  if (selected === "r2") return "r2" as const;
  throw new Error("GPHKM_PRIVATE_STORAGE_DRIVER must be set to r2 outside development");
}

function readR2Config(): R2Config {
  const accountId = process.env.GPHKM_R2_ACCOUNT_ID?.trim() ?? "";
  const bucket = process.env.GPHKM_R2_BUCKET?.trim() ?? "";
  const accessKeyId = process.env.GPHKM_R2_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.GPHKM_R2_SECRET_ACCESS_KEY?.trim() ?? "";
  if (!/^[a-f0-9]{32}$/i.test(accountId)
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    || !accessKeyId || /[\r\n\0]/.test(accessKeyId)
    || !secretAccessKey || /[\r\n\0]/.test(secretAccessKey)) {
    throw new Error("R2 private storage configuration is incomplete");
  }
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

export function assertPrivateFileStorageConfigured() {
  const selected = driver();
  if (selected === "r2") readR2Config();
  else localRootPath();
}

function clientForR2() {
  const config = readR2Config();
  if (!r2Client || r2Bucket !== config.bucket) {
    r2Client?.destroy();
    r2Bucket = config.bucket;
    r2Client = new S3Client({
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      region: "auto",
      maxAttempts: 2,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }
  return { client: r2Client, bucket: config.bucket };
}

function localRootPath() {
  if (process.env.NODE_ENV !== "development") throw new Error("Private filesystem storage is development-only");
  const configured = process.env.GPHKM_PRIVATE_STORAGE_PATH?.trim();
  if (!configured) throw new Error("GPHKM_PRIVATE_STORAGE_PATH is required for local private files");
  if (!isAbsolute(configured)) throw new Error("GPHKM_PRIVATE_STORAGE_PATH must be absolute");
  const root = configured;
  const publicRoot = resolve(process.cwd(), "public");
  const publicPath = publicRoot + sep;
  if (root === publicRoot || root.startsWith(publicPath)) throw new Error("Private storage cannot be inside public");
  return root;
}

async function ensureLocalRoot() {
  const root = localRootPath();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await realpath(root);
  const publicRoot = resolve(process.cwd(), "public");
  const publicPath = publicRoot + sep;
  if (actual === publicRoot || actual.startsWith(publicPath)) throw new Error("Private storage cannot resolve inside public");
  await chmod(actual, 0o700);
  return actual;
}

function safeKey(key: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new Error("Private file is unavailable");
  }
  return key;
}

export async function savePrivateFile(bytes: Buffer, key: string) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PRIVATE_FILE_BYTES) {
    throw new Error("Private file size is invalid");
  }
  const selected = driver();
  const safeStorageKey = safeKey(key);

  if (selected === "r2") {
    const { client, bucket } = clientForR2();
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: safeStorageKey,
      Body: bytes,
      ContentType: "application/octet-stream",
      CacheControl: "private, no-store",
      IfNoneMatch: "*",
    }), { abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) });
    return key;
  }

  const root = await ensureLocalRoot();
  const path = join(root, safeStorageKey);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return key;
}

export async function readPrivateFile(key: string, maxBytes: number) {
  const safeStorageKey = safeKey(key);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PRIVATE_FILE_BYTES) {
    throw new Error("Private file is unavailable");
  }
  if (driver() === "r2") {
    const { client, bucket } = clientForR2();
    const output = await client.send(new GetObjectCommand({ Bucket: bucket, Key: safeStorageKey }), {
      abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS),
    });
    const body = output.Body as (AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }) | undefined;
    if (!body) throw new Error("Private file is unavailable");
    return readBoundedObjectBody(body, output.ContentLength, maxBytes);
  }

  const root = await ensureLocalRoot();
  const handle = await open(join(root, safeStorageKey), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error("Private file is unavailable");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function deletePrivateFile(key: string) {
  const safeStorageKey = safeKey(key);
  if (driver() === "r2") {
    const { client, bucket } = clientForR2();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: safeStorageKey }), {
      abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS),
    });
    return;
  }

  const root = await ensureLocalRoot();
  const path = join(root, safeStorageKey);
  const resolved = resolve(path);
  if (relative(root, resolved).startsWith("..")) throw new Error("Private file is unavailable");
  await rm(path, { force: true });
}
