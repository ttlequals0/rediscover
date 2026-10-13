// Core logic: pick a random Karakeep bookmark, check the link is alive, and
// archive + tag links that are clearly dead. No dependencies beyond Node 20+.

// Bookmarks fetched on each side of the random point in time (Karakeep allows up to 100).
const HALF_WINDOW = 50;
// Karakeep list cursors are `${id}_${createdAt ISO}` and are not checked against real
// bookmarks; the id only breaks ties on identical timestamps, so a high value keeps them.
const TIE_BREAK_ID = "zzzzzzzzzzzzzzzzzzzzzzzz";
const USER_AGENT = "Mozilla/5.0 (compatible; rediscover)";

export function createKarakeepClient({ url, apiKey, fetchImpl = fetch }) {
  const base = `${url.replace(/\/+$/, "")}/api/v1`;

  async function call(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Karakeep ${method} ${path} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  return {
    async listBookmarks(params) {
      // Archived bookmarks are left out, so archived dead links never come back up.
      const query = new URLSearchParams({ archived: "false", ...params });
      return (await call("GET", `/bookmarks?${query}`)).bookmarks ?? [];
    },
    archive: (id) => call("PATCH", `/bookmarks/${encodeURIComponent(id)}`, { archived: true }),
    tag: (id, tagName) => call("POST", `/bookmarks/${encodeURIComponent(id)}/tags`, { tags: [{ tagName }] }),
  };
}

/**
 * Picks a bookmark at random across the whole collection: jump to a random point in time
 * between the oldest and newest bookmark, then choose randomly among the (up to 100)
 * bookmarks saved around that point — 50 before and 50 after. Sampling a window rather
 * than the single nearest bookmark keeps bulk imports and bookmarks after long quiet gaps
 * from dominating, and centring it keeps the newest and oldest bookmarks reachable.
 * Collections under 100 bookmarks are therefore sampled uniformly.
 */
export async function pickRandomBookmark(client, { oldest, newest }, accept, random = Math.random) {
  const start = Date.parse(oldest.createdAt);
  const end = Date.parse(newest.createdAt);
  const pivot = Math.ceil(start + random() * (end - start + 1));

  const cursor = `${TIE_BREAK_ID}_${new Date(pivot).toISOString()}`;
  const [before, after] = await Promise.all([
    client.listBookmarks({ limit: String(HALF_WINDOW), sortOrder: "desc", cursor }),
    client.listBookmarks({ limit: String(HALF_WINDOW), sortOrder: "asc", cursor }),
  ]);
  const window = [...new Map([...before, ...after].map((b) => [b.id, b])).values()];
  const candidates = window.filter(accept);
  if (candidates.length === 0) return accept(oldest) ? oldest : null;
  return candidates[Math.floor(random() * candidates.length)];
}

const DEAD_NETWORK_CODES = new Set(["ENOTFOUND", "EAI_NONAME", "ECONNREFUSED", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);

/**
 * Checks a link and classifies it:
 *  - "alive": anything that answered, including bot walls (401/403/429) and 503 challenges
 *  - "dead":  the domain no longer resolves, refuses connections, has a broken certificate,
 *             or the page answers 404/410 — safe to archive
 *  - "down":  timeouts and server errors — skipped for now but never archived, since a site
 *             that is merely having a bad day shouldn't lose its bookmark
 */
export async function checkLink(url, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const attempt = (method) =>
    fetchImpl(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    });

  try {
    let response = await attempt("HEAD");
    // Plenty of servers mishandle HEAD; confirm any error with a GET.
    if (response.status >= 400) {
      await response.body?.cancel();
      response = await attempt("GET");
    }
    await response.body?.cancel();
    const { status } = response;
    if (status === 404 || status === 410) return { state: "dead", reason: `HTTP ${status}` };
    if (status >= 500 && status !== 503) return { state: "down", reason: `HTTP ${status}` };
    return { state: "alive", reason: `HTTP ${status}` };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    if (code && DEAD_NETWORK_CODES.has(code)) return { state: "dead", reason: code };
    return { state: "down", reason: code ?? error?.name ?? "error" };
  }
}

/**
 * Finds a random bookmark that is worth opening. Dead links are archived and tagged
 * (when enabled) and another bookmark is tried; links that are only "down" are skipped.
 */
export async function findLiveBookmark(client, config, log = () => {}) {
  const {
    maxAttempts = 5,
    linksOnly = true,
    checkLinks = true,
    archiveDead = true,
    deadTag = "dead-link",
    timeoutMs,
    fetchImpl,
    random,
  } = config;
  const accept = (bookmark) => !linksOnly || bookmark?.content?.type === "link";

  const [[newest], [oldest]] = await Promise.all([
    client.listBookmarks({ limit: "1", sortOrder: "desc" }),
    client.listBookmarks({ limit: "1", sortOrder: "asc" }),
  ]);
  if (!newest) return { bookmark: null, skipped: [] };

  const skipped = [];
  const tried = new Set();
  for (let i = 0; i < maxAttempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const bookmark = await pickRandomBookmark(client, { oldest, newest }, accept, random);
    if (!bookmark) break;
    if (tried.has(bookmark.id)) continue;
    tried.add(bookmark.id);

    const url = bookmark.content?.type === "link" ? bookmark.content.url : null;
    if (!url || !checkLinks) return { bookmark, skipped };

    // eslint-disable-next-line no-await-in-loop
    let result = await checkLink(url, { timeoutMs, fetchImpl });
    if (result.state === "dead" && archiveDead) {
      // Confirm before touching anything, to rule out a one-off blip.
      // eslint-disable-next-line no-await-in-loop
      result = await checkLink(url, { timeoutMs, fetchImpl });
    }
    if (result.state === "alive") return { bookmark, skipped };

    const entry = { id: bookmark.id, url, ...result, archived: false };
    if (result.state === "dead" && archiveDead) {
      try {
        // Tag first so the bookmark can be found again under the tag even if archiving fails.
        // eslint-disable-next-line no-await-in-loop
        if (deadTag) await client.tag(bookmark.id, deadTag);
        // eslint-disable-next-line no-await-in-loop
        await client.archive(bookmark.id);
        entry.archived = true;
      } catch (error) {
        log(`Could not archive dead bookmark ${bookmark.id}: ${error.message}`);
      }
    }
    log(`Skipped ${result.state} link ${url} (${result.reason})${entry.archived ? " — archived" : ""}`);
    skipped.push(entry);
  }

  return { bookmark: null, skipped };
}
