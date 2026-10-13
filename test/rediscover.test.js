import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { checkLink, findLiveBookmark, pickRandomBookmark } from "../src/rediscover.js";
import { createServer } from "../src/server.js";

// A local "internet" with pages in various states of health.
let site;
let siteUrl;
before(async () => {
  site = http.createServer((req, res) => {
    const routes = {
      "/ok": () => res.writeHead(200).end("hi"),
      "/gone": () => res.writeHead(404).end(),
      "/removed": () => res.writeHead(410).end(),
      "/no-head": () => res.writeHead(req.method === "HEAD" ? 405 : 200).end(),
      "/bot-wall": () => res.writeHead(403).end(),
      "/broken": () => res.writeHead(500).end(),
      "/challenge": () => res.writeHead(503).end(),
      "/moved": () => res.writeHead(301, { Location: "/ok" }).end(),
      "/moved-gone": () => res.writeHead(301, { Location: "/gone" }).end(),
      "/slow": () => setTimeout(() => res.writeHead(200).end(), 2000),
    };
    (routes[req.url] ?? routes["/gone"])();
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});
after(() => {
  site.closeAllConnections();
  site.close();
});

describe("checkLink", () => {
  const cases = [
    ["/ok", "alive"],
    ["/no-head", "alive"],
    ["/bot-wall", "alive"],
    ["/challenge", "alive"],
    ["/moved", "alive"],
    ["/gone", "dead"],
    ["/removed", "dead"],
    ["/moved-gone", "dead"],
    ["/broken", "down"],
  ];
  for (const [path, expected] of cases) {
    it(`${path} is ${expected}`, async () => {
      assert.equal((await checkLink(`${siteUrl}${path}`)).state, expected);
    });
  }

  it("treats a timeout as down, not dead", async () => {
    assert.equal((await checkLink(`${siteUrl}/slow`, { timeoutMs: 200 })).state, "down");
  });

  it("treats a refused connection as dead", async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    assert.deepEqual(await checkLink(`http://127.0.0.1:${port}/`), { state: "dead", reason: "ECONNREFUSED" });
  });

  it("treats a domain that no longer resolves as dead", async () => {
    const fakeFetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    assert.equal((await checkLink("https://long-gone.example", { fetchImpl: fakeFetch })).state, "dead");
  });
});

// In-memory stand-in for the parts of the Karakeep API we use, mirroring its cursor rules
// (desc: createdAt < cursor, or equal with id <= cursor id).
function fakeKarakeep(bookmarks) {
  const calls = { list: [], archived: [], tagged: [] };
  const live = () => bookmarks.filter((b) => !calls.archived.includes(b.id));
  return {
    calls,
    async listBookmarks({ limit, sortOrder, cursor, archived }) {
      calls.list.push({ limit, sortOrder, cursor, archived });
      let rows = [...live()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (b.id > a.id ? 1 : -1));
      if (sortOrder === "asc") rows.reverse();
      if (cursor) {
        const [id, iso] = cursor.split("_");
        const t = Date.parse(iso);
        const past = (b) => (sortOrder === "asc" ? Date.parse(b.createdAt) > t : Date.parse(b.createdAt) < t);
        rows = rows.filter((b) => past(b) || (Date.parse(b.createdAt) === t && b.id <= id));
      }
      return rows.slice(0, Number(limit));
    },
    async archive(id) {
      calls.archived.push(id);
    },
    async tag(id, tagName) {
      calls.tagged.push([id, tagName]);
    },
  };
}

const link = (id, createdAt, url) => ({ id, createdAt, content: { type: "link", url } });
const note = (id, createdAt) => ({ id, createdAt, content: { type: "text", text: "hello" } });

describe("pickRandomBookmark", () => {
  const bookmarks = [
    link("a", "2015-01-01T00:00:00.000Z", "https://a"),
    link("b", "2018-06-01T00:00:00.000Z", "https://b"),
    note("c", "2020-01-01T00:00:00.000Z"),
    link("d", "2026-01-01T00:00:00.000Z", "https://d"),
  ];
  const bounds = { oldest: bookmarks[0], newest: bookmarks[3] };

  it("can reach both the oldest and the newest bookmark", async () => {
    // Only the first random() call places the pivot; the second picks within the window.
    const rolls = (...values) => () => values.shift();
    const client = fakeKarakeep(bookmarks);
    assert.equal((await pickRandomBookmark(client, bounds, () => true, rolls(0, 0))).id, "a");
    assert.equal((await pickRandomBookmark(client, bounds, () => true, rolls(0, 0.99))).id, "d");
    assert.equal((await pickRandomBookmark(client, bounds, () => true, rolls(0.99, 0.99))).id, "d");
  });

  it("samples a small collection evenly", async () => {
    const client = fakeKarakeep(bookmarks);
    const counts = {};
    for (let i = 0; i < 4000; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { id } = await pickRandomBookmark(client, bounds, () => true);
      counts[id] = (counts[id] ?? 0) + 1;
    }
    for (const id of ["a", "b", "c", "d"]) assert.ok(counts[id] > 850 && counts[id] < 1150, JSON.stringify(counts));
  });

  it("only returns bookmarks the filter accepts", async () => {
    const client = fakeKarakeep(bookmarks);
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const picked = await pickRandomBookmark(client, bounds, (b) => b.content.type === "link");
      assert.notEqual(picked.id, "c");
    }
  });

  it("asks Karakeep for 50 bookmarks either side of the pivot", async () => {
    const client = fakeKarakeep(bookmarks);
    await pickRandomBookmark(client, bounds, () => true, () => 0.5);
    assert.deepEqual(
      client.calls.list.map(({ limit, sortOrder }) => [limit, sortOrder]),
      [["50", "desc"], ["50", "asc"]],
    );
    assert.equal(client.calls.list[0].cursor, client.calls.list[1].cursor);
  });

  it("reaches every bookmark over many picks", async () => {
    const client = fakeKarakeep(bookmarks);
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      seen.add((await pickRandomBookmark(client, bounds, () => true)).id);
    }
    assert.deepEqual([...seen].sort(), ["a", "b", "c", "d"]);
  });
});

describe("findLiveBookmark", () => {
  it("archives and tags a dead link, then returns a live one", async () => {
    const client = fakeKarakeep([
      link("dead", "2016-01-01T00:00:00.000Z", `${siteUrl}/gone`),
      link("alive", "2024-01-01T00:00:00.000Z", `${siteUrl}/ok`),
    ]);
    // Pick the oldest window first (the dead link), then the newest.
    const rolls = [0, 0, 0.99, 0.99];
    const random = () => rolls.shift() ?? 0.99;
    const result = await findLiveBookmark(client, { random });

    assert.equal(result.bookmark.id, "alive");
    assert.deepEqual(client.calls.tagged, [["dead", "dead-link"]]);
    assert.deepEqual(client.calls.archived, ["dead"]);
    assert.equal(result.skipped[0].archived, true);
  });

  it("skips but never archives a link that is only down", async () => {
    const client = fakeKarakeep([link("flaky", "2016-01-01T00:00:00.000Z", `${siteUrl}/broken`)]);
    const result = await findLiveBookmark(client, { maxAttempts: 3 });
    assert.equal(result.bookmark, null);
    assert.deepEqual(client.calls.archived, []);
    assert.equal(result.skipped[0].state, "down");
  });

  it("leaves dead links alone when archiving is off", async () => {
    const client = fakeKarakeep([link("dead", "2016-01-01T00:00:00.000Z", `${siteUrl}/gone`)]);
    await findLiveBookmark(client, { archiveDead: false });
    assert.deepEqual(client.calls.archived, []);
    assert.deepEqual(client.calls.tagged, []);
  });

  it("asks Karakeep for unarchived bookmarks only", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ bookmarks: [] }), { status: 200 });
    };
    const { createKarakeepClient } = await import("../src/rediscover.js");
    await createKarakeepClient({ url: "http://karakeep:3000/", apiKey: "k", fetchImpl }).listBookmarks({ limit: "1" });
    assert.equal(calls[0], "http://karakeep:3000/api/v1/bookmarks?archived=false&limit=1");
  });

  it("returns nothing for an empty collection", async () => {
    assert.equal((await findLiveBookmark(fakeKarakeep([]), {})).bookmark, null);
  });
});

describe("server", () => {
  const config = { publicUrl: "https://keep.example", maxAttempts: 5, checkLinks: true, archiveDead: true, deadTag: "dead-link" };

  async function request(server, path) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: "manual" });
    } finally {
      server.close();
    }
  }

  it("redirects /random to a live link", async () => {
    const client = fakeKarakeep([link("x", "2020-01-01T00:00:00.000Z", `${siteUrl}/ok`)]);
    const response = await request(createServer(config, { client }), "/random");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${siteUrl}/ok`);
  });

  it("opens notes inside Karakeep", async () => {
    const client = fakeKarakeep([note("n1", "2020-01-01T00:00:00.000Z")]);
    const response = await request(createServer(config, { client }), "/random");
    assert.equal(response.headers.get("location"), "https://keep.example/dashboard/preview/n1");
  });

  it("returns JSON with ?format=json", async () => {
    const client = fakeKarakeep([link("x", "2020-01-01T00:00:00.000Z", `${siteUrl}/ok`)]);
    const response = await request(createServer(config, { client }), "/random?format=json");
    const body = await response.json();
    assert.equal(body.bookmark.id, "x");
    assert.equal(body.bookmark.url, `${siteUrl}/ok`);
  });

  it("shows a retry page when every pick is dead", async () => {
    const client = fakeKarakeep([link("d", "2020-01-01T00:00:00.000Z", `${siteUrl}/gone`)]);
    const response = await request(createServer(config, { client }), "/random");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Roll again/);
    assert.match(html, /archived/);
  });

  it("reports Karakeep being unreachable", async () => {
    const client = { listBookmarks: async () => Promise.reject(new Error("ECONNREFUSED")) };
    const response = await request(createServer(config, { client }), "/random");
    assert.equal(response.status, 502);
  });
});
