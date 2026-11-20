import { getJSON, getText, send } from "./_lib.js";
import {
  FEED_URL, ARCHIVE_URL, SUBSTACK, SLUG_RE, slugUrl,
  parseFeed, fromArchive, mergePosts, isPaywalled, transformBody, articlesPayload,
  renderIndex, renderPost, renderNotFound,
} from "../lib/substack.js";

// /writing and /writing/:slug (see vercel.json rewrites). /api/articles is the same
// function in json mode: the Hobby plan caps a deployment at 12 functions, so the old
// api/articles.js lives here now.
// Cached at the edge for 5 minutes and served stale while it refreshes, so a new
// Substack post shows up here within minutes without a redeploy.

const OK_CACHE = "public, s-maxage=300, stale-while-revalidate=86400";
const FAIL_CACHE = "public, s-maxage=30, stale-while-revalidate=60";

function html(res, status, body, cache = OK_CACHE) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.status(status).send(body);
}

function toSubstack(res, slug) {
  res.setHeader("Cache-Control", FAIL_CACHE);
  res.redirect(302, slug ? slugUrl(slug) : `${SUBSTACK}/archive`);
}

const settle = (p) => p.then((v) => v, () => null);

export default async function handler(req, res) {
  const raw = req.query?.slug;
  const slug = Array.isArray(raw) ? raw[0] : raw;

  if (req.query?.json) {
    const [xml, rows] = await Promise.all([settle(getText(FEED_URL)), settle(getJSON(ARCHIVE_URL))]);
    const posts = mergePosts(rows ? fromArchive(rows) : [], xml ? parseFeed(xml) : []);
    const body = { articles: articlesPayload(posts), updatedAt: Date.now() };
    if (!posts.length) body.error = "Substack unreachable";
    send(res, body, posts.length ? 600 : 30, posts.length ? 86400 : 60);
    return;
  }

  if (!slug) {
    const [xml, rows] = await Promise.all([settle(getText(FEED_URL)), settle(getJSON(ARCHIVE_URL))]);
    const posts = mergePosts(rows ? fromArchive(rows) : [], xml ? parseFeed(xml) : []);
    return html(res, 200, renderIndex(posts), posts.length ? OK_CACHE : FAIL_CACHE);
  }

  if (!SLUG_RE.test(slug)) return html(res, 404, renderNotFound(), FAIL_CACHE);

  // Preferred source: the feed. Older posts that fell out of it come from the post API.
  const xml = await settle(getText(FEED_URL));
  let post = xml ? parseFeed(xml).find((p) => p.slug === slug) : null;

  if (!post) {
    const api = await settle(getJSON(`${SUBSTACK}/api/v1/posts/${encodeURIComponent(slug)}`));
    if (api && api.body_html && api.title) {
      if (api.audience && api.audience !== "everyone") return toSubstack(res, slug);
      post = { slug, title: api.title, subtitle: api.subtitle || "", date: api.post_date || null, cover: api.cover_image || null, html: api.body_html };
    }
  }

  if (!post) {
    // Substack unreachable or no such post: send readers to the original rather than a dead end.
    return xml ? html(res, 404, renderNotFound(), FAIL_CACHE) : toSubstack(res, slug);
  }
  if (isPaywalled(post.html)) return toSubstack(res, slug);

  html(res, 200, renderPost(post, transformBody(post.html, { slug })));
}
