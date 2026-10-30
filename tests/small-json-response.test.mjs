import assert from "node:assert/strict";
import test from "node:test";
import { readSmallJsonResponse } from "../src/modules/security/small-json-response.ts";

const jsonResponse = (body, headers = {}) => new Response(body, {
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
});

test("small provider JSON responses require JSON and parse bounded content", async () => {
  assert.deepEqual(await readSmallJsonResponse(jsonResponse('{"id":"mail_123"}')), { id: "mail_123" });
  await assert.rejects(readSmallJsonResponse(new Response("{}", { headers: { "content-type": "text/plain" } })), /invalid or too large/);
  await assert.rejects(readSmallJsonResponse(jsonResponse("{")), /invalid or too large/);
});

test("small provider JSON responses reject declared and streamed oversized bodies", async () => {
  await assert.rejects(readSmallJsonResponse(jsonResponse("{}", { "content-length": String(256 * 1024 + 1) })), /invalid or too large/);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(new Uint8Array([0x7b]));
      controller.close();
    },
  });
  await assert.rejects(readSmallJsonResponse(new Response(body, { headers: { "content-type": "application/json" } })), /invalid or too large/);
});
