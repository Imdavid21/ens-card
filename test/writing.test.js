import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARCHIVE_URL, parseFeed, fromArchive, mergePosts, transformBody, isPaywalled, renderIndex, renderPost, readMinutes } from "../lib/substack.js";
import handler from "../api/writing.js";

const XML = readFileSync(new URL("./fixtures/substack-feed.xml", import.meta.url), "utf8");
const feed = parseFeed(XML);
const newest = feed.find((p) => p.slug === "newest-post");
const body = transformBody(newest.html, { slug: "newest-post" });

test("feed parses, sorts newest first and skips non post links", () => {
  assert.deepEqual(feed.map((p) => p.slug), ["newest-post", "subscribers-only", "older-free-post"]);
  assert.equal(newest.title, "Newest post");
  assert.equal(newest.subtitle, "A subtitle & more");
  assert.equal(newest.cover, "https://substackcdn.com/image/fetch/newest.png");
  assert.equal(newest.date, "2026-11-16T13:02:30.000Z");
});

test("scripts, handlers, js links and foreign iframes are stripped", () => {
  for (const bad of ["<script", "pwned", "onclick", "onerror", "javascript:", "evil.example"]) assert.ok(!body.html.includes(bad), bad);
  assert.ok(body.html.includes("player.vimeo.com/video/123"));
});

test("tweets become X embeds with the text escaped, bad tweet urls are dropped", () => {
  assert.equal(body.hasTweets, true);
  assert.match(body.html, /<blockquote class="twitter-tweet" data-theme="dark"/);
  assert.match(body.html, /https:\/\/twitter\.com\/Hyperliquid_In\/status\/2122313053249388581/);
  assert.match(body.html, /Thanks for coming &lt;3 &amp; see you soon/);
  assert.ok(!body.html.includes("card html that must not survive"));
  assert.ok(!body.html.includes("evil.example/status"));
});

test("subscribe blocks go, real buttons stay", () => {
  assert.ok(!/Subscribe now|Subscribe widget/.test(body.html));
  assert.match(body.html, /<p class="btn-row"><a class="btn" href="https:\/\/luma\.com\/x6m1zvfh"[^>]*>RSVP Now<\/a><\/p>/);
});

test("images keep picture and caption without the enlarge wrapper, headings lose icon buttons", () => {
  assert.match(body.html, /<picture><source[^>]+srcset=[^>]*>(?:<\/source>)?<img src="https:\/\/substackcdn\.com\/full\.png"/);
  assert.match(body.html, /<figcaption[^>]*>A caption<\/figcaption>/);
  assert.ok(!body.html.includes("<iframe></iframe>"));
  assert.ok(!body.html.includes("image-link") && !body.html.includes("<svg") && !body.html.includes("<button"));
  assert.match(body.html, /<h2>A section<\/h2>/);
});

test("video: youtube is embedded privacy mode, native video links back to Substack", () => {
  assert.match(body.html, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.match(body.html, /href="https:\/\/hyperliquidindia\.substack\.com\/p\/newest-post"[^>]*>Watch the video on Substack/);
});

test("external links open in a new tab, links to our own posts become /writing paths", () => {
  assert.match(body.html, /<a href="https:\/\/example\.com\/out" target="_blank" rel="noopener noreferrer">/);
  const older = transformBody(feed.find((p) => p.slug === "older-free-post").html);
  assert.match(older.html, /<a href="\/writing\/newest-post">link to a sibling post<\/a>/);
});

test("tables are wrapped so they scroll on phones", () => assert.match(body.html, /<div class="table-wrap"><table>/));

test("paywall detection and archive merge", () => {
  assert.equal(isPaywalled(feed.find((p) => p.slug === "subscribers-only").html), true);
  assert.equal(isPaywalled(newest.html), false);
  const archive = fromArchive([
    { slug: "ancient", title: "Ancient", post_date: "2025-01-01T00:00:00Z", audience: "everyone", type: "newsletter" },
    { slug: "newest-post", title: "Newest post", post_date: "2026-11-16T13:02:30Z", audience: "only_paid", subtitle: "From archive" },
    { slug: "a-thread", title: "Thread", type: "thread" },
  ]);
  const merged = mergePosts(archive, feed);
  assert.deepEqual(merged.map((p) => p.slug), ["newest-post", "subscribers-only", "older-free-post", "ancient"]);
  assert.equal(merged[0].paid, true);
  assert.equal(merged[0].cover, "https://substackcdn.com/image/fetch/newest.png");
});

test("pages carry canonical, tweet script only when needed, and escape titles", () => {
  const page = renderPost({ ...newest, title: 'Fees <b>"cheap"</b>' }, body);
  assert.match(page, /<link rel="canonical" href="https:\/\/hyperliquidindia\.com\/writing\/newest-post">/);
  assert.match(page, /platform\.twitter\.com\/widgets\.js/);
  assert.ok(!page.includes("<b>\"cheap\"</b>"));
  const plain = renderPost(feed[2], transformBody(feed[2].html));
  assert.ok(!plain.includes("widgets.js"));
  assert.ok(!/[—–]/.test(page), "no em or en dashes in site copy");
  const idx = renderIndex(mergePosts([], feed.filter((p) => !isPaywalled(p.html))));
  assert.match(idx, /href="\/writing\/newest-post"/);
  assert.match(idx, /api\/v1\/free\?nojs=true/);
});

test("reading time is at least a minute", () => assert.equal(readMinutes(3), 1));

// ---- handler, with Substack faked ----
function run(url, routes) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const hit = routes[String(u)];
    if (!hit) return new Response("nope", { status: 404 });
    return new Response(hit.body, { status: hit.status || 200, headers: { "content-type": hit.type || "text/plain" } });
  };
  const u = new URL(url, "https://x.test");
  const req = { query: Object.fromEntries(u.searchParams) };
  const out = { headers: {}, status: 0, body: "", redirect: null };
  const res = {
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
    status(c) { out.status = c; return this; },
    send(b) { out.body = b; },
    json(b) { out.json = b; },
    redirect(c, l) { out.status = c; out.redirect = l; },
  };
  return handler(req, res).then(() => out).finally(() => { globalThis.fetch = real; });
}
const FEEDS = { "https://hyperliquidindia.substack.com/feed": { body: XML, type: "application/rss+xml" } };

test("handler: index renders posts and is edge cached", async () => {
  const r = await run("/writing", FEEDS);
  assert.equal(r.status, 200);
  assert.match(r.headers["cache-control"], /s-maxage=300/);
  assert.match(r.body, /Newest post/);
});

test("handler: post renders from the feed", async () => {
  const r = await run("/writing/newest-post?slug=newest-post", FEEDS);
  assert.equal(r.status, 200);
  assert.match(r.body, /<h1>Newest post<\/h1>/);
});

test("handler: paywalled posts and unreachable Substack redirect to the original", async () => {
  const locked = await run("/writing?slug=subscribers-only", FEEDS);
  assert.equal(locked.redirect, "https://hyperliquidindia.substack.com/p/subscribers-only");
  const down = await run("/writing?slug=newest-post", {});
  assert.equal(down.redirect, "https://hyperliquidindia.substack.com/p/newest-post");
});

test("handler: older post comes from the post API, unknown slug is a 404, bad slug never fetches", async () => {
  const api = { "https://hyperliquidindia.substack.com/api/v1/posts/ancient": { type: "application/json", body: JSON.stringify({ title: "Ancient", subtitle: "s", post_date: "2025-01-01T00:00:00Z", audience: "everyone", body_html: "<p>old words</p>" }) } };
  const ok = await run("/writing?slug=ancient", { ...FEEDS, ...api });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /old words/);
  assert.equal((await run("/writing?slug=missing", FEEDS)).status, 404);
  assert.equal((await run("/writing?slug=..%2Fadmin", FEEDS)).status, 404);
});

test("handler: /api/articles json mode keeps the home grid shape, falls back to the feed when the archive fails", async () => {
  const archive = [
    { slug: "newest-post", title: "Newest post", subtitle: "From archive", post_date: "2026-11-16T13:02:30Z", audience: "everyone", cover_image: "https://c/x.png" },
    { slug: "ancient", title: "Ancient", post_date: "2025-01-01T00:00:00Z", audience: "everyone" },
    { slug: "locked-old", title: "Locked old", post_date: "2025-02-01T00:00:00Z", audience: "only_paid" },
  ];
  const both = await run("/api/articles?json=1", { ...FEEDS, [ARCHIVE_URL]: { type: "application/json", body: JSON.stringify(archive) } });
  assert.equal(both.status, 200);
  assert.match(both.headers["cache-control"], /s-maxage=600/);
  assert.equal(both.headers["access-control-allow-origin"], "*");
  assert.deepEqual(both.json.articles.map((a) => [a.slug, a.url]), [
    ["newest-post", "/writing/newest-post"],
    ["subscribers-only", "https://hyperliquidindia.substack.com/p/subscribers-only"],
    ["older-free-post", "/writing/older-free-post"],
    ["locked-old", "https://hyperliquidindia.substack.com/p/locked-old"],
    ["ancient", "/writing/ancient"],
  ]);
  assert.equal(both.json.articles[0].cover, "https://c/x.png");
  assert.equal(both.json.articles[0].substackUrl, "https://hyperliquidindia.substack.com/p/newest-post");

  // The archive returned HTTP 400 on production; the feed alone must still fill the grid.
  const feedOnly = await run("/api/articles?json=1", { ...FEEDS, [ARCHIVE_URL]: { status: 400, body: "bad" } });
  assert.deepEqual(feedOnly.json.articles.map((a) => a.slug), ["newest-post", "subscribers-only", "older-free-post"]);
  assert.equal(feedOnly.json.articles[1].url, "https://hyperliquidindia.substack.com/p/subscribers-only");

  const down = await run("/api/articles?json=1", {});
  assert.deepEqual(down.json.articles, []);
  assert.match(down.json.error, /unreachable/);
});

test("a free post that talks about paywalls is not treated as locked", () => assert.equal(isPaywalled("<p>Why a paywall helps writers</p>"), false));

test("active and form elements are removed before sanitizing", () => {
  const evil = '<p>ok</p><noscript><img src=x onerror=alert(1)></noscript><form action="javascript:alert(2)"><button formaction="javascript:alert(3)">go</button><input name=a></form><video poster="javascript:alert(4)" src="x.mp4"></video><style>*{display:none}</style><textarea><b onclick=alert(5)></textarea>';
  const out = transformBody(evil).html;
  assert.match(out, /<p>ok<\/p>/);
  for (const bad of ["noscript", "onerror", "<form", "formaction", "javascript:", "poster", "<style", "onclick", "<input", "<textarea"]) assert.ok(!out.includes(bad), bad);
});

test("tweet fallback text drops Substack's own markup but keeps the mentions", () => {
  const attrs = JSON.stringify({ url: "https://x.com/a/status/123456", username: "a", full_text: 'Thanks <span class="tweet-fake-link">@BitgetWallet</span> and <b>team</b>' });
  const out = transformBody(`<div class="twitter-embed" data-attrs='${attrs}'></div>`).html;
  assert.match(out, /<p>Thanks @BitgetWallet and team<\/p>/);
  assert.ok(!out.includes("tweet-fake-link") && !out.includes("&lt;span"));
});
