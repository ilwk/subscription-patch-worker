import { transform } from "./adapters";
import { SubscriptionError } from "./errors";
export interface Env {
  UPSTREAM_URL: string;
  ACCESS_TOKEN: string;
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
    const [a, b] = await Promise.all([hash(tokens[0]), hash(env.ACCESS_TOKEN)]);
    let diff = 0;
    const x = new Uint8Array(a),
      y = new Uint8Array(b);
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
  } catch {
    return false;
  }
}
async function readBody(r: Response) {
  if (!r.body)
    throw new SubscriptionError(
      "UPSTREAM_EMPTY",
      "Upstream returned an empty body.",
    );
  const reader = r.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024)
        throw new SubscriptionError(
          "UPSTREAM_TOO_LARGE",
          "Upstream body exceeds 5 MiB.",
        );
      try {
        body += decoder.decode(value, { stream: true });
      } catch {
        throw new SubscriptionError(
          "UPSTREAM_ENCODING",
          "Upstream body is not valid UTF-8.",
        );
      }
    }
    try {
      body += decoder.decode();
    } catch {
      throw new SubscriptionError(
        "UPSTREAM_ENCODING",
        "Upstream body is not valid UTF-8.",
      );
    }
    if (!body.trim())
      throw new SubscriptionError(
        "UPSTREAM_EMPTY",
        "Upstream returned an empty body.",
      );
    return body;
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
    let url: URL;
    try {
      url = new URL(env.UPSTREAM_URL);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error();
    } catch {
      throw new SubscriptionError(
        "INVALID_UPSTREAM_URL",
        "UPSTREAM_URL must be an HTTPS URL without embedded credentials.",
        503,
      );
    }
    const upstream = await fetch(url, {
      headers: {
        accept: "application/json, application/yaml, text/yaml, */*",
        "user-agent":
          env.UPSTREAM_USER_AGENT ||
          request.headers.get("user-agent") ||
          "sing-box/1.14.0",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400)
      throw new SubscriptionError(
        "UPSTREAM_REDIRECT",
        "Upstream returned a redirect. Set UPSTREAM_URL to the final subscription URL.",
      );
    if (!upstream.ok)
      throw new SubscriptionError(
        "UPSTREAM_HTTP_ERROR",
        `Upstream returned HTTP ${upstream.status}.`,
      );
    const result = transform(await readBody(upstream));
    return reply(result.body, 200, { "content-type": result.contentType });
  } catch (error) {
    // Fetch and parser errors can contain credentials. Do not log or expose them.
    const failure = controller.signal.aborted
      ? new SubscriptionError(
          "UPSTREAM_TIMEOUT",
          "Upstream request exceeded 20 seconds.",
          504,
        )
      : error instanceof SubscriptionError
        ? error
        : new SubscriptionError(
            "UPSTREAM_FETCH_FAILED",
            "Could not fetch or read upstream. Check upstream availability and network access.",
          );
    return reply(`${failure.code}: ${failure.message}`, failure.status, {
      "x-error-code": failure.code,
    });
  } finally {
    clearTimeout(timer);
  }
}
export default { fetch: handleRequest };
