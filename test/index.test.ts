import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { transform } from "../src/adapters";
import { mergeConfig } from "../src/merge";
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
  assert.doesNotMatch(await r.text(), /private-token/);
});
