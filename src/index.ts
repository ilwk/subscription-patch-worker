import { isIP } from "node:net";
import { transform } from "./adapters";
export interface Env {
  UPSTREAM_URL: string;
  ACCESS_TOKEN: string;
  EXCLUDE_CIDRS?: string;
  UPSTREAM_USER_AGENT?: string;
}
function reply(
  body: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
async function authorized(request: Request, env: Env) {
  try {
    const tokens = new URL(request.url).searchParams.getAll("token");
    if (tokens.length !== 1 || !tokens[0]) return false;
    const hash = (s: string) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    const [a, b] = await Promise.all([
      hash(tokens[0]),
      hash(env.ACCESS_TOKEN),
    ]);
    let diff = 0;
    const x = new Uint8Array(a),
      y = new Uint8Array(b);
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  } catch {
    return false;
  }
}
function cidrs(value = "10.0.0.0/8") {
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    !list.length ||
    list.some((c) => {
      const [ip, prefix, extra] = c.split("/");
      const version = isIP(ip);
      return (
        extra !== undefined ||
        !version ||
        !/^\d+$/.test(prefix ?? "") ||
        Number(prefix) > (version === 4 ? 32 : 128)
      );
    })
  )
    throw new Error("Invalid CIDRs");
  return [...new Set(list)];
}
async function readBody(r: Response) {
  if (!r.body) throw new Error("Empty body");
  const reader = r.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024) throw new Error("Oversized body");
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function handleRequest(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET")
    return reply("Method not allowed", 405, { allow: "GET" });
  if (path === "/health") return reply("ok", 200);
  if (path !== "/config") return reply("Not found", 404);
  if (!env.UPSTREAM_URL || !env.ACCESS_TOKEN)
    return reply("Missing secrets", 503);
  if (!(await authorized(request, env)))
    return reply("Invalid or missing token", 401);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const excludes = cidrs(env.EXCLUDE_CIDRS);
    const url = new URL(env.UPSTREAM_URL);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid upstream");
    const upstream = await fetch(url, {
      headers: {
        accept: "application/json, application/yaml, text/yaml, */*",
        "user-agent":
          env.UPSTREAM_USER_AGENT ||
          request.headers.get("user-agent") ||
          "sing-box/1.14.0",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error("Upstream failed");
    const result = transform(await readBody(upstream), excludes);
    return reply(result.body, 200, { "content-type": result.contentType });
  } catch {
    // Fetch and parser errors can contain credentials. Do not log or expose them.
    return reply("Subscription fetch or patch failed", 502);
  } finally {
    clearTimeout(timer);
  }
}
export default { fetch: handleRequest };
