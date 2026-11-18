// Loaded only by the isolated auth integration runner. Keep message bodies in
// the test process over IPC because they contain restricted one-time links.
if (process.env.GPHKM_AUTH_EMAIL_CHECK_CHILD !== "true" || !process.send) {
  throw new Error("Auth email capture requires the local test runner");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.resend.com") return originalFetch(input, init);

  if (url.pathname !== "/emails" || init?.method !== "POST" || typeof init.body !== "string") {
    return new Response(null, { status: 400 });
  }
  const { to, subject, text } = JSON.parse(init.body);
  if (!Array.isArray(to) || to.length !== 1 || !/^[a-z0-9-]+@gphkm\.test$/.test(to[0])
    || typeof subject !== "string" || typeof text !== "string") {
    return new Response(null, { status: 400 });
  }

  process.send({ type: "auth-email-fixture", to: to[0], subject, text });
  return Response.json({ id: "local-auth-email-fixture" });
};
