import http from "node:http";

import { createKarakeepClient, findLiveBookmark } from "./rediscover.js";

function readConfig(env = process.env) {
  const bool = (value, fallback) => (value === undefined || value === "" ? fallback : /^(1|true|yes|on)$/i.test(value));
  const int = (value, fallback) => (Number.isFinite(Number.parseInt(value, 10)) ? Number.parseInt(value, 10) : fallback);

  const config = {
    karakeepUrl: env.KARAKEEP_URL,
    apiKey: env.KARAKEEP_API_KEY,
    // Where your browser reaches Karakeep; used to open notes/files and as a fallback.
    publicUrl: (env.KARAKEEP_PUBLIC_URL || env.KARAKEEP_URL || "").replace(/\/+$/, ""),
    port: int(env.PORT, 8080),
    maxAttempts: int(env.MAX_ATTEMPTS, 5),
    timeoutMs: int(env.CHECK_TIMEOUT_MS, 8000),
    checkLinks: bool(env.CHECK_LINKS, true),
    archiveDead: bool(env.ARCHIVE_DEAD_LINKS, true),
    deadTag: env.DEAD_LINK_TAG ?? "dead-link",
    linksOnly: bool(env.LINKS_ONLY, false),
  };
  if (!config.karakeepUrl || !config.apiKey) {
    throw new Error("KARAKEEP_URL and KARAKEEP_API_KEY must be set");
  }
  return config;
}

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

function previewUrl(config, id) {
  return config.publicUrl ? `${config.publicUrl}/dashboard/preview/${id}` : null;
}

function targetFor(config, bookmark) {
  if (bookmark.content?.type === "link") return bookmark.content.url;
  return previewUrl(config, bookmark.id);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const AUTO_ROLL_LIMIT = 3;

function nothingFoundPage(config, skipped, autoRolls) {
  const rows = skipped
    .map((s) => {
      const saved = previewUrl(config, s.id);
      return `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a> — ${escapeHtml(s.reason)}${s.archived ? " (archived)" : ""}${saved ? ` · <a href="${escapeHtml(saved)}">saved copy</a>` : ""}</li>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rediscover</title>
${skipped.length && autoRolls < AUTO_ROLL_LIMIT ? `<meta http-equiv="refresh" content="3;url=/random?auto=${autoRolls + 1}">` : ""}
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">No live bookmark in ${skipped.length || "any"} tries</h1>
<p><a href="/random">Roll again</a>${skipped.length && autoRolls < AUTO_ROLL_LIMIT ? " (rolling again in 3 seconds)" : ""}</p>${rows ? `<ul>${rows}</ul>` : ""}</body>`;
}

export function createServer(config, deps = {}) {
  const client = deps.client ?? createKarakeepClient({ url: config.karakeepUrl, apiKey: config.apiKey });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }

    if (url.pathname !== "/random" || req.method !== "GET") {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found. Try /random");
      return;
    }

    const wantsJson = url.searchParams.get("format") === "json";
    try {
      const result = await findLiveBookmark(
        client,
        { ...config, linksOnly: config.linksOnly || !config.publicUrl, fetchImpl: deps.fetchImpl, random: deps.random },
        log,
      );
      const target = result.bookmark && targetFor(config, result.bookmark);

      if (wantsJson) {
        const bookmark = result.bookmark && {
          id: result.bookmark.id,
          title: result.bookmark.title ?? result.bookmark.content?.title ?? null,
          url: target,
          createdAt: result.bookmark.createdAt,
        };
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ bookmark, skipped: result.skipped }));
        return;
      }

      if (target) {
        res.writeHead(302, { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(nothingFoundPage(config, result.skipped, Number.parseInt(url.searchParams.get("auto"), 10) || 0));
    } catch (error) {
      log(`Error: ${error.message}`);
      res.writeHead(502, { "Content-Type": wantsJson ? "application/json" : "text/plain" });
      res.end(wantsJson ? JSON.stringify({ error: error.message }) : `Could not reach Karakeep: ${error.message}`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = readConfig();
  const server = createServer(config);
  server.listen(config.port, () => {
    log(
      `rediscover listening on :${config.port} (link checks ${config.checkLinks ? "on" : "off"}, ` +
        `archive dead links ${config.archiveDead ? `on, tag "${config.deadTag}"` : "off"})`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { readConfig };
