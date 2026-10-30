export function mergeSessionCookies(requestCookie: string, responseCookies: string[]): string {
  const cookies = new Map<string, string>();
  for (const cookie of requestCookie.split(";")) {
    const pair = cookie.trim();
    const equalsAt = pair.indexOf("=");
    if (equalsAt > 0) cookies.set(pair.slice(0, equalsAt), pair.slice(equalsAt + 1));
  }
  for (const setCookie of responseCookies) {
    const pair = setCookie.split(";", 1)[0]?.trim() ?? "";
    const equalsAt = pair.indexOf("=");
    if (equalsAt <= 0) continue;
    const name = pair.slice(0, equalsAt);
    const value = pair.slice(equalsAt + 1);
    if (value) cookies.set(name, value);
    else cookies.delete(name);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
