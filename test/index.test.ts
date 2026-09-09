import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { transform } from "../src/adapters";
import { handleRequest, type Env } from "../src/index";
const env: Env = {
  UPSTREAM_URL: "https://example.com/sub",
  ACCESS_TOKEN: "secret",
};
const request = (token = "secret") =>
  new Request("https://worker.test/config?token=" + encodeURIComponent(token), {
    headers: {
      "user-agent": "sing-box/1.14.0",
    },
  });
test("sing-box preserves fields and patches every TUN idempotently", () => {
  const c = {
    inbounds: [
      { type: "tun", route_exclude_address: ["192.168.0.0/16"] },
      { type: "tun" },
      { type: "mixed" },
    ],
    outbounds: [{ type: "vless", uuid: "fixture" }],
    route: { final: "proxy" },
  };
  const result = transform(JSON.stringify(c), ["10.0.0.0/8"]);
  assert.equal(transform(result.body, ["10.0.0.0/8"]).body, result.body);
  const output = JSON.parse(result.body);
  assert.deepEqual(output.outbounds, c.outbounds);
  assert.deepEqual(output.route, c.route);
  assert.deepEqual(output.inbounds[0].route_exclude_address, [
    "192.168.0.0/16",
    "10.0.0.0/8",
  ]);
  assert.deepEqual(output.inbounds[1].route_exclude_address, ["10.0.0.0/8"]);
  assert.deepEqual(output.inbounds[2], { type: "mixed" });
});
test("Mihomo YAML keeps nodes, DNS, rules and disabled TUN", () => {
  const input =
    "proxies: []\nrules: [MATCH,DIRECT]\ndns: {enable: true}\ntun:\n  enable: false\n  route-exclude-address: [192.168.0.0/16]\n";
  const output = parse(transform(input, ["10.0.0.0/8"]).body);
  assert.equal(output.tun.enable, false);
  assert.deepEqual(output.tun["route-exclude-address"], [
    "192.168.0.0/16",
    "10.0.0.0/8",
  ]);
  assert.deepEqual(output.dns, { enable: true });
});
test("Mihomo missing TUN adds options without enabling it; JSON supported", () => {
  const c = JSON.parse(transform('{"proxies":[]}', ["10.0.0.0/8"]).body);
  assert.deepEqual(c.tun, { "route-exclude-address": ["10.0.0.0/8"] });
});
test("rejects unsupported, duplicate YAML keys, missing TUN and malformed exclusions", () => {
  for (const input of [
    "{}",
    "hello",
    "tun: {}\ntun: {}",
    '{"inbounds":[]}',
    '{"tun":{"route-exclude-address":"bad"}}',
  ])
    assert.throws(() => transform(input, ["10.0.0.0/8"]));
});
test("unauthorized requests never fetch upstream", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  assert.equal((await handleRequest(request("wrong"), env)).status, 401);
  assert.equal((await handleRequest(request(""), env)).status, 401);
  assert.equal((await handleRequest(new Request("https://worker.test/config?token=secret&token=secret"), env)).status, 401);
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
  assert.deepEqual((await r.json()).inbounds[0].route_exclude_address, [
    "10.0.0.0/8",
  ]);
});
test("upstream and parser failures do not leak credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("private-token");
  });
  const r = await handleRequest(request(), env);
  assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /private-token/);
});
test("invalid configured CIDR fails closed", async () => {
  assert.equal(
    (await handleRequest(request(), { ...env, EXCLUDE_CIDRS: "10.0.0.0/999" }))
      .status,
    502,
  );
});
