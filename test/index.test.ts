import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { transform } from "../src/adapters";
import { mergeConfig } from "../src/merge";
import { SubscriptionError } from "../src/errors";
import { handleRequest, type Env } from "../src/index";
const env: Env = {
  UPSTREAM_URL: "https://example.com/sub",
  ACCESS_TOKEN: "secret",
};
const request = (token = "secret") =>
  new Request("https://worker.test/config?token=" + encodeURIComponent(token), {
    headers: { "user-agent": "sing-box/1.14.0" },
  });
test("empty overrides preserve upstream bytes and do not require TUN", () => {
  for (const body of [
    '{ "outbounds": [] }',
    "# preserve this comment\nproxies: []\n",
  ]) {
    assert.equal(transform(body).body, body);
  }
});
test("objects merge recursively; arrays replace; scalars and null override", () => {
  const base = {
    dns: { enable: true, nameservers: ["old"] },
    rules: ["old"],
    value: 1,
  };
  const patch = { dns: { nameservers: ["new"] }, rules: [], value: null };
  assert.deepEqual(mergeConfig(base, patch, "mihomo"), {
    dns: { enable: true, nameservers: ["new"] },
    rules: [],
    value: null,
  });
  assert.deepEqual(base.dns.nameservers, ["old"]);
  assert.deepEqual(patch.rules, []);
});
test("sing-box matches tags, retains order and credentials, appends new entries", () => {
  const base = {
    inbounds: [{ type: "tun", tag: "tun-in", mtu: 9000 }, { type: "mixed" }],
    outbounds: [{ type: "vless", tag: "node", uuid: "fixture" }],
    route: { rules: [{ action: "sniff" }], final: "node" },
  };
  const patch = {
    inbounds: [
      { tag: "tun-in", mtu: 1500 },
      { type: "mixed", tag: "new" },
    ],
    outbounds: [{ tag: "node", tls: { enabled: true } }],
  };
  const result = mergeConfig(base, patch, "sing-box");
  assert.deepEqual(result.inbounds, [
    { type: "tun", tag: "tun-in", mtu: 1500 },
    { type: "mixed" },
    { type: "mixed", tag: "new" },
  ]);
  assert.deepEqual(result.outbounds, [
    { type: "vless", tag: "node", uuid: "fixture", tls: { enabled: true } },
  ]);
  assert.deepEqual(result.route, base.route);
  assert.deepEqual(mergeConfig(result, patch, "sing-box"), result);
  assert.equal(base.inbounds[0].mtu, 9000);
});
test("ordinary nested arrays replace rather than tag merge; explicit [] clears", () => {
  const base = {
    outbounds: [{ type: "selector", tag: "select", outbounds: ["one", "two"] }],
  };
  assert.deepEqual(
    mergeConfig(
      base,
      { outbounds: [{ tag: "select", outbounds: ["three"] }] },
      "sing-box",
    ),
    { outbounds: [{ type: "selector", tag: "select", outbounds: ["three"] }] },
  );
  assert.deepEqual(mergeConfig(base, { outbounds: [] }, "sing-box"), {
    outbounds: [],
  });
});
test("missing or duplicate override tags and incomplete additions fail", () => {
  const base = { inbounds: [{ type: "tun", tag: "tun-in" }] };
  for (const entries of [
    [{ mtu: 1500 }],
    [{ tag: "typo" }],
    [{ tag: "tun-in" }, { tag: "tun-in" }],
  ]) {
    assert.throws(() => mergeConfig(base, { inbounds: entries }, "sing-box"));
  }
});
test("Mihomo chooses YAML override, keeps DNS siblings, replaces rules in order", () => {
  const body =
    "proxies: []\ndns: {enable: true, nameserver: [old]}\nrules: ['MATCH,DIRECT']\n";
  const overrides = {
    "sing-box": { log: { level: "debug" } },
    mihomo: parse(
      "dns:\n  nameserver: [new]\nrules:\n  - DOMAIN,example.com,DIRECT\n  - MATCH,PROXY\n",
    ),
  };
  const result = transform(body, overrides);
  assert.match(result.contentType, /yaml/);
  assert.deepEqual(parse(result.body), {
    proxies: [],
    dns: { enable: true, nameserver: ["new"] },
    rules: ["DOMAIN,example.com,DIRECT", "MATCH,PROXY"],
  });
});
test("sing-box chooses JSON override independently", () => {
  const result = transform('{"inbounds":[]}', {
    "sing-box": { log: { level: "debug" } },
    mihomo: { mode: "global" },
  });
  assert.deepEqual(JSON.parse(result.body), {
    inbounds: [],
    log: { level: "debug" },
  });
});
test("rejects invalid, ambiguous and dangerous configuration", () => {
  for (const body of [
    "{}",
    "hello",
    "tun: {}\ntun: {}",
    '{"inbounds":[],"proxies":[]}',
  ])
    assert.throws(() => transform(body));
  assert.throws(() =>
    mergeConfig({}, JSON.parse('{"__proto__":{"polluted":true}}'), "mihomo"),
  );
  assert.throws(() => mergeConfig({}, [], "mihomo"));
});
test("unauthorized requests never fetch upstream", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  assert.equal((await handleRequest(request("wrong"), env)).status, 401);
  assert.equal((await handleRequest(request(""), env)).status, 401);
  assert.equal(
    (
      await handleRequest(
        new Request("https://worker.test/config?token=secret&token=secret"),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (await handleRequest(new Request("https://worker.test/config"), env))
      .status,
    401,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});
test("authenticated request preserves UA and never forwards credentials", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      assert.equal(String(_url), env.UPSTREAM_URL);
      const h = new Headers(init?.headers);
      assert.equal(h.get("authorization"), null);
      assert.equal(h.get("user-agent"), "sing-box/1.14.0");
      return Response.json({ inbounds: [{ type: "tun" }] });
    },
  );
  const r = await handleRequest(request(), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { inbounds: [{ type: "tun" }] });
});
test("upstream and parser failures do not leak credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("private-token");
  });
  const r = await handleRequest(request(), env);
  assert.equal(r.status, 502);
  assert.equal(r.headers.get("x-error-code"), "UPSTREAM_FETCH_FAILED");
  assert.doesNotMatch(await r.text(), /private-token/);
});

test("upstream failures have safe, distinct error codes", async (t) => {
  const cases: [() => Response, string][] = [
    [
      () => new Response("private-token", { status: 403 }),
      "UPSTREAM_HTTP_ERROR",
    ],
    [
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://private-token.test" },
        }),
      "UPSTREAM_REDIRECT",
    ],
    [() => new Response("  "), "UPSTREAM_EMPTY"],
    [() => new Response(null, { status: 204 }), "UPSTREAM_EMPTY"],
    [() => new Response("x".repeat(5 * 1024 * 1024 + 1)), "UPSTREAM_TOO_LARGE"],
    [() => new Response(new Uint8Array([0xff])), "UPSTREAM_ENCODING"],
    [() => new Response("proxies: [private-token"), "UPSTREAM_PARSE_ERROR"],
    [() => new Response("private-token"), "UNSUPPORTED_FORMAT"],
    [() => Response.json({ inbounds: [], proxies: [] }), "UNSUPPORTED_FORMAT"],
  ];
  for (const [response, code] of cases) {
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init?: RequestInit) => {
        assert.equal(init?.redirect, "manual");
        return response();
      },
    );
    const result = await handleRequest(request(), env);
    assert.equal(result.status, 502);
    assert.equal(result.headers.get("x-error-code"), code);
    const body = await result.text();
    assert.ok(body.startsWith(code + ":"));
    assert.doesNotMatch(body, /private-token/);
    t.mock.restoreAll();
  }
});

test("invalid upstream URL is rejected before fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error();
  });
  for (const url of [
    "invalid",
    "http://example.com",
    "https://user:private-token@example.com",
  ]) {
    const result = await handleRequest(request(), {
      ...env,
      UPSTREAM_URL: url,
    });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get("x-error-code"), "INVALID_UPSTREAM_URL");
    assert.doesNotMatch(await result.text(), /private-token/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("timeout aborts the fetch and returns 504", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const aborted = new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("private-token")),
          { once: true },
        );
      });
      t.mock.timers.tick(20000);
      return aborted;
    },
  );
  const result = await handleRequest(request(), env);
  assert.equal(result.status, 504);
  assert.equal(result.headers.get("x-error-code"), "UPSTREAM_TIMEOUT");
  assert.doesNotMatch(await result.text(), /private-token/);
});

test("override and merge errors are distinct and do not expose values", () => {
  for (const [override, code] of [
    [[], "INVALID_OVERRIDE"],
    [{ inbounds: [{ tag: "private-token" }] }, "MERGE_FAILED"],
  ] as const) {
    assert.throws(
      () => transform('{"inbounds":[]}', { "sing-box": override, mihomo: {} }),
      (error: unknown) => {
        assert.ok(error instanceof SubscriptionError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private-token/);
        return true;
      },
    );
  }
});
