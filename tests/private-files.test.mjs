import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile as readDiskFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertPrivateFileStorageConfigured, deletePrivateFile, readPrivateFile, savePrivateFile } from "../src/server/storage/private-files.ts";

const envNames = [
  "NODE_ENV", "GPHKM_PRIVATE_STORAGE_DRIVER", "GPHKM_PRIVATE_STORAGE_PATH",
  "GPHKM_R2_ACCOUNT_ID", "GPHKM_R2_BUCKET", "GPHKM_R2_ACCESS_KEY_ID", "GPHKM_R2_SECRET_ACCESS_KEY",
];
let previousEnv;
let testRoot;
let originalSend;

beforeEach(() => {
  previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  originalSend = S3Client.prototype.send;
});

afterEach(async () => {
  S3Client.prototype.send = originalSend;
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

async function localStorage() {
  process.env.NODE_ENV = "development";
  process.env.GPHKM_PRIVATE_STORAGE_DRIVER = "filesystem";
  testRoot = await mkdtemp(join(tmpdir(), "gphkm-private-files-"));
  process.env.GPHKM_PRIVATE_STORAGE_PATH = join(testRoot, "private");
  return process.env.GPHKM_PRIVATE_STORAGE_PATH;
}

function r2Storage() {
  process.env.NODE_ENV = "production";
  process.env.GPHKM_PRIVATE_STORAGE_DRIVER = "r2";
  process.env.GPHKM_R2_ACCOUNT_ID = "a".repeat(32);
  process.env.GPHKM_R2_BUCKET = "gphkm-private-files";
  process.env.GPHKM_R2_ACCESS_KEY_ID = "test-access-key";
  process.env.GPHKM_R2_SECRET_ACCESS_KEY = "test-secret-key";
}

function byteStream(chunks) {
  const state = { destroyed: false };
  const body = Object.assign((async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })(), { destroy() { state.destroyed = true; } });
  return { body, state };
}

test("local private storage writes, bounds, reads, and removes UUID objects", async () => {
  await localStorage();
  const key = randomUUID();
  const source = Buffer.from("private supplier source");
  await savePrivateFile(source, key);
  assert.deepEqual(await readPrivateFile(key, source.length), source);
  await assert.rejects(readPrivateFile(key, source.length - 1), /unavailable/);
  await assert.rejects(readPrivateFile("../private", source.length), /unavailable/);
  await deletePrivateFile(key);
  await assert.rejects(readPrivateFile(key, source.length), /ENOENT|unavailable/);
});

test("local storage refuses the public tree and refuses production filesystem fallback", async () => {
  process.env.NODE_ENV = "development";
  process.env.GPHKM_PRIVATE_STORAGE_DRIVER = "filesystem";
  process.env.GPHKM_PRIVATE_STORAGE_PATH = resolve("public/private-files");
  assert.throws(assertPrivateFileStorageConfigured, /cannot be inside public/);

  process.env.NODE_ENV = "production";
  delete process.env.GPHKM_PRIVATE_STORAGE_DRIVER;
  assert.throws(assertPrivateFileStorageConfigured, /must be set to r2/);
});

test("local reads do not follow symlinks and deleting one leaves its target intact", async () => {
  const root = await localStorage();
  await mkdir(root, { recursive: true });
  const target = join(testRoot, "outside-target");
  const key = randomUUID();
  await writeFile(target, "outside");
  await symlink(target, join(root, key));

  await assert.rejects(readPrivateFile(key, 100));
  await deletePrivateFile(key);
  assert.equal(await readDiskFile(target, "utf8"), "outside");
});

test("R2 uses private create-once objects and bounded streamed reads", async () => {
  r2Storage();
  const calls = [];
  const stream = byteStream(["private ", "evidence"]);
  S3Client.prototype.send = async function (command, options) {
    calls.push({ command, options });
    if (command instanceof GetObjectCommand) return { ContentLength: 16, Body: stream.body };
    return {};
  };

  const key = randomUUID();
  const data = Buffer.from("private evidence");
  await savePrivateFile(data, key);
  assert.deepEqual(await readPrivateFile(key, 64), data);
  await deletePrivateFile(key);

  assert.ok(calls[0].command instanceof PutObjectCommand);
  assert.deepEqual(calls[0].command.input, {
    Bucket: "gphkm-private-files", Key: key, Body: data,
    ContentType: "application/octet-stream", CacheControl: "private, no-store", IfNoneMatch: "*",
  });
  assert.ok(calls[0].options.abortSignal instanceof AbortSignal);
  assert.ok(calls[1].command instanceof GetObjectCommand);
  assert.equal(calls[1].command.input.Key, key);
  assert.ok(calls[2].command instanceof DeleteObjectCommand);
  assert.deepEqual(calls[2].command.input, { Bucket: "gphkm-private-files", Key: key });
});

test("R2 rejects oversized and truncated responses and closes oversized streams", async () => {
  r2Storage();
  const tooLarge = byteStream(["ignored"]);
  S3Client.prototype.send = async function () { return { ContentLength: 8, Body: tooLarge.body }; };
  await assert.rejects(readPrivateFile(randomUUID(), 4), /unavailable/);
  assert.equal(tooLarge.state.destroyed, true);

  const truncated = byteStream(["short"]);
  S3Client.prototype.send = async function () { return { ContentLength: 12, Body: truncated.body }; };
  await assert.rejects(readPrivateFile(randomUUID(), 20), /unavailable/);
});

test("R2 configuration fails closed when a credential or bucket setting is invalid", () => {
  r2Storage();
  delete process.env.GPHKM_R2_SECRET_ACCESS_KEY;
  assert.throws(assertPrivateFileStorageConfigured, /configuration is incomplete/);
});
