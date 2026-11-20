// Substack to hyperliquidindia.com/writing.
// The RSS feed carries the full HTML of every public post. This module parses it,
// rebuilds Substack-only blocks (tweets, buttons, video) as plain HTML that works
// off Substack, sanitizes the result and renders pages in the site's black and foam look.

import { XMLParser } from "fast-xml-parser";
import sanitizeHtml from "sanitize-html";
import * as cheerio from "cheerio";

export const SUBSTACK = "https://hyperliquidindia.substack.com";
export const SITE = "https://hyperliquidindia.com";
export const FEED_URL = `${SUBSTACK}/feed`;
export const ARCHIVE_URL = `${SUBSTACK}/api/v1/archive?sort=new&limit=50`;
export const slugUrl = (slug) => `${SUBSTACK}/p/${slug}`;
export const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/;

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function text(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text(v.__cdata ?? v["#text"] ?? "");
  return String(v);
}

// ---------- feed ----------

export function parseFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    cdataPropName: "__cdata",
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml);
  const items = [].concat(doc?.rss?.channel?.item ?? []);
  return items
    .map((it) => {
      const m = text(it.link).match(/\/p\/([^/?#]+)/);
      if (!m || !SLUG_RE.test(m[1])) return null;
      const enc = Array.isArray(it.enclosure) ? it.enclosure[0] : it.enclosure;
      const d = new Date(text(it.pubDate));
      return {
        slug: m[1],
        title: text(it.title),
        subtitle: text(it.description),
        url: slugUrl(m[1]),
        date: isNaN(d) ? null : d.toISOString(),
        cover: enc?.["@_url"] || null,
        html: text(it["content:encoded"]),
      };
    })
    .filter((p) => p && p.title)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function fromArchive(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => p && p.slug && p.title && SLUG_RE.test(p.slug) && (!p.type || p.type === "newsletter"))
    .map((p) => ({
      slug: p.slug,
      title: p.title,
      subtitle: p.subtitle || "",
      url: slugUrl(p.slug),
      date: p.post_date || null,
      cover: p.cover_image || null,
      paid: !!p.audience && p.audience !== "everyone",
    }));
}

// Archive first (it reaches back further), then anything only the feed knows.
export function mergePosts(archive, feed) {
  const bySlug = new Map();
  for (const p of archive) bySlug.set(p.slug, p);
  for (const p of feed) {
    const prev = bySlug.get(p.slug);
    bySlug.set(p.slug, prev ? { ...p, ...prev, cover: prev.cover || p.cover, subtitle: prev.subtitle || p.subtitle } : p);
  }
  return [...bySlug.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function isPaywalled(html) {
  return /this post is for (paid|paying) subscribers|paywall/i.test(html || "");
}

// ---------- body ----------

const attrs = (el) => {
  try { return JSON.parse(el.attr("data-attrs") || "{}"); } catch { return {}; }
};

const SELF_LINK = /^https?:\/\/(?:hyperliquidindia\.substack\.com|open\.substack\.com\/pub\/hyperliquidindia)\/p\/([^/?#]+)/i;

export function transformBody(html, { slug = "" } = {}) {
  const $ = cheerio.load(`<div id="__r">${html || ""}</div>`, null, false);
  let hasTweets = false;

  // Posts of ours link to our own pages. Done first so links we add later to the Substack original stay as they are.
  $("a[href]").each((_, el) => {
    const m = String($(el).attr("href")).match(SELF_LINK);
    if (m && SLUG_RE.test(m[1])) $(el).attr("href", `/writing/${m[1]}`);
  });

  // Substack's own subscribe blocks. The page shows its own form instead.
  $(".subscription-widget-wrap, .subscription-widget, .subscribe-widget, .footer-subscription-widget").remove();

  // Buttons: keep real calls to action (RSVP, links), drop subscribe and share.
  $("p.button-wrapper, div.button-wrapper").each((_, el) => {
    const a = attrs($(el));
    const label = String(a.text || $(el).text() || "").trim();
    const url = String(a.url || $(el).find("a").attr("href") || "");
    if (!url || /subscribe|share|leave a comment|restack/i.test(`${label} ${a.action || ""}`) || /substack\.com\/(subscribe|app)/i.test(url)) {
      $(el).remove();
      return;
    }
    $(el).replaceWith(`<p class="btn-row"><a class="btn" href="${esc(url)}">${esc(label || "Open")}</a></p>`);
  });

  // Tweets become real X embeds, with the tweet text as the fallback.
  $(".twitter-embed").each((_, el) => {
    const a = attrs($(el));
    const m = String(a.url || "").match(/(?:x|twitter)\.com\/(\w{1,15})\/status\/(\d{5,25})/i);
    if (!m) { $(el).remove(); return; }
    hasTweets = true;
    const who = a.username || m[1];
    $(el).replaceWith(
      `<blockquote class="twitter-tweet" data-theme="dark" data-dnt="true" data-conversation="none">` +
        `<p>${esc(a.full_text || "")}</p>${esc(a.name || who)} (@${esc(who)}) ` +
        `<a href="https://twitter.com/${m[1]}/status/${m[2]}">View on X</a></blockquote>`
    );
  });

  // Video: YouTube can be embedded, Substack native video cannot leave Substack.
  $(".youtube-wrap").each((_, el) => {
    const id = String(attrs($(el)).videoId || ($(el).attr("id") || "").replace(/^youtube\d*-/, ""));
    if (/^[\w-]{6,20}$/.test(id)) {
      $(el).replaceWith(`<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/${id}" title="Video" loading="lazy" allowfullscreen></iframe></div>`);
    } else $(el).remove();
  });
  $(".native-video-embed, .video-embed").each((_, el) => {
    $(el).replaceWith(slug ? `<p class="media-note"><a href="${slugUrl(slug)}">Watch the video on Substack</a></p>` : "");
  });

  // Images: drop the click to enlarge wrapper and icon buttons, keep picture and caption.
  $(".image-link-expand, .pencraft, button, svg").remove();
  $("a.image-link").each((_, el) => { $(el).replaceWith($(el).contents()); });
  $("table").wrap('<div class="table-wrap"></div>');

  const clean = sanitizeHtml($("#__r").html() || "", {
    allowedTags: ["h1", "h2", "h3", "h4", "p", "br", "hr", "a", "strong", "b", "em", "i", "u", "s", "del", "sup", "sub", "code", "pre",
      "blockquote", "ul", "ol", "li", "figure", "figcaption", "img", "picture", "source", "table", "thead", "tbody", "tr", "th", "td", "div", "span", "iframe"],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "srcset", "sizes", "alt", "width", "height", "loading"],
      source: ["srcset", "sizes", "type", "media"],
      blockquote: ["class", "data-theme", "data-dnt", "data-conversation"],
      iframe: ["src", "title", "loading", "allowfullscreen"],
      div: ["class"], p: ["class"],
      h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"],
      td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], ol: ["start"],
    },
    allowedClasses: {
      div: ["embed", "table-wrap", "captioned-image-container", "image2-inset"],
      p: ["btn-row", "media-note"],
      a: ["btn"],
      blockquote: ["twitter-tweet"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    exclusiveFilter: (f) => f.tag === "iframe" && !f.attribs.src,
    allowedIframeHostnames: ["www.youtube-nocookie.com", "player.vimeo.com", "open.spotify.com"],
    transformTags: {
      a: (tag, a) => (/^https?:\/\//i.test(a.href || "") ? { tagName: "a", attribs: { ...a, target: "_blank", rel: "noopener noreferrer" } } : { tagName: "a", attribs: a }),
      img: (tag, a) => ({ tagName: "img", attribs: { ...a, loading: "lazy" } }),
    },
  });

  const words = sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).split(/\s+/).filter(Boolean).length;
  return { html: clean, hasTweets, words };
}

export const readMinutes = (words) => Math.max(1, Math.round(words / 230));

// ---------- pages ----------

const fmtDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
};

const CSS = `
:root{--bg:#000;--fg:#F6FEFD;--f80:rgba(246,254,253,.8);--f60:rgba(246,254,253,.6);--f40:rgba(246,254,253,.4);--f20:rgba(246,254,253,.2);--f12:rgba(246,254,253,.12);--f06:rgba(246,254,253,.06);--deep:#0b0c0c;--sans:"Geist","Helvetica Neue",Arial,sans-serif;--serif:"Newsreader",Georgia,serif;--mono:"Geist Mono",ui-monospace,Menlo,monospace;--ease:cubic-bezier(.16,1,.3,1);color-scheme:dark}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:inherit}h1,h2,h3,h4,p{margin:0}img{max-width:100%}::selection{background:var(--fg);color:var(--bg)}:focus-visible{outline:2px solid var(--fg);outline-offset:3px;border-radius:6px}
.wrap{max-width:1100px;margin:0 auto;padding:0 max(20px,env(safe-area-inset-left,0px))}
.nav{border-bottom:1px solid var(--f12)}.nav .wrap{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-block:18px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font:500 15px var(--sans)}.brand img{height:22px;width:auto;display:block}
.links{display:flex;gap:22px;font:400 14px var(--sans);color:var(--f60)}.links a{text-decoration:none;transition:color .3s var(--ease)}.links a:hover,.links a[aria-current]{color:var(--fg)}
.col{max-width:720px;margin:0 auto}
.mono{font:400 12px/1.4 var(--mono);letter-spacing:.02em;color:var(--f60)}
.head{padding:clamp(56px,9vw,112px) 0 clamp(28px,4vw,48px)}
.head h1{font:600 clamp(36px,6vw,64px)/1.05 var(--sans);letter-spacing:-.03em}
.head p{margin-top:16px;max-width:560px;color:var(--f60);font-size:18px}
.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--f12)}
.row{display:grid;grid-template-columns:150px 1fr 180px;gap:28px;align-items:center;padding:28px 0;border-bottom:1px solid var(--f12);text-decoration:none}
.row h2{font:600 clamp(20px,2.4vw,26px)/1.25 var(--sans);letter-spacing:-.015em;transition:opacity .3s var(--ease)}
.row p{margin-top:6px;color:var(--f60);font-size:15px;line-height:1.5}
.row .thumb{aspect-ratio:16/9;border-radius:8px;border:1px solid var(--f12);background:var(--deep) center/cover no-repeat}
.list:hover .row:not(:hover){opacity:.55}.row{transition:opacity .3s var(--ease)}
.back{display:inline-block;margin-top:40px;color:var(--f60);text-decoration:none;font:400 14px var(--sans)}.back:hover{color:var(--fg)}
.post-head{padding:clamp(24px,5vw,56px) 0 clamp(28px,4vw,44px)}
.post-head h1{margin-top:14px;font:600 clamp(32px,5.2vw,54px)/1.08 var(--sans);letter-spacing:-.03em}
.post-head .sub{margin-top:18px;font:italic 300 clamp(19px,2.2vw,23px)/1.45 var(--serif);color:var(--f60)}
.prose{font:400 18px/1.75 var(--sans);color:var(--f80);overflow-wrap:anywhere}
.prose>*+*{margin-top:1.25em}
.prose h2{margin-top:2.2em;font:600 clamp(24px,3vw,30px)/1.25 var(--sans);letter-spacing:-.015em;color:var(--fg)}
.prose h3{margin-top:1.9em;font:600 21px/1.35 var(--sans);color:var(--fg)}.prose h4{margin-top:1.6em;font:600 18px/1.4 var(--sans);color:var(--fg)}
.prose a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--f40);text-underline-offset:3px;transition:text-decoration-color .3s}.prose a:hover{text-decoration-color:var(--fg)}
.prose strong{color:var(--fg);font-weight:600}
.prose ul,.prose ol{padding-left:1.4em}.prose li+li{margin-top:.5em}
.prose img{max-width:100%;height:auto}.prose figure img,.prose picture img{display:block;width:100%;border-radius:10px;border:1px solid var(--f12)}
.prose figure{margin:2em 0}.prose figcaption{margin-top:10px;font:400 13px/1.5 var(--mono);color:var(--f60);text-align:center}
.prose blockquote:not(.twitter-tweet){margin-left:0;padding-left:1.1em;border-left:2px solid var(--f20);font:italic 300 1.15em/1.6 var(--serif);color:var(--f80)}
.prose .twitter-tweet{margin:2em auto!important}
.prose pre{background:var(--deep);border:1px solid var(--f12);border-radius:10px;padding:16px;overflow:auto;font:400 14px/1.6 var(--mono)}
.prose code{font:400 .88em var(--mono);background:var(--f06);padding:.15em .35em;border-radius:5px}.prose pre code{background:none;padding:0}
.prose hr{border:0;border-top:1px solid var(--f12);margin:2.6em 0}
.table-wrap{overflow-x:auto}.prose table{border-collapse:collapse;width:100%;font-size:15px;line-height:1.5}.prose th,.prose td{border-bottom:1px solid var(--f12);padding:10px 12px;text-align:left;vertical-align:top}.prose th{color:var(--fg);font-weight:600}
.embed{position:relative;aspect-ratio:16/9}.embed iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px}
.btn-row .btn,.sub-form button{display:inline-block;background:var(--fg);color:var(--bg);padding:12px 22px;border-radius:999px;border:0;text-decoration:none;font:500 15px var(--sans);cursor:pointer;transition:opacity .3s var(--ease)}
.btn-row .btn:hover,.sub-form button:hover{opacity:.85}
.media-note{font:400 14px var(--mono);color:var(--f60)}
.sub-box{margin:clamp(56px,8vw,96px) 0 0;padding:clamp(24px,4vw,40px);border:1px solid var(--f12);border-radius:16px;background:var(--f03,rgba(246,254,253,.03))}
.sub-box h2{font:600 clamp(22px,3vw,28px)/1.2 var(--sans);letter-spacing:-.02em}
.sub-box p{margin-top:8px;color:var(--f60);font-size:16px;max-width:520px}
.sub-form{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}
.sub-form input{flex:1 1 240px;min-width:0;background:var(--bg);color:var(--fg);border:1px solid var(--f20);border-radius:999px;padding:12px 18px;font:400 15px var(--sans)}
.sub-form input::placeholder{color:var(--f40)}.sub-form input:focus{outline:none;border-color:var(--fg)}
footer{margin-top:clamp(72px,10vw,128px);border-top:1px solid var(--f12);padding:32px 0 48px;color:var(--f40);font-size:14px}
footer .wrap{display:flex;gap:24px;justify-content:space-between;flex-wrap:wrap}footer p{max-width:520px}footer nav{display:flex;gap:20px}footer a{text-decoration:none;color:var(--f60)}footer a:hover{color:var(--fg)}
.empty{padding:48px 0;color:var(--f60)}
@media (max-width:760px){.row{grid-template-columns:1fr;gap:10px}.row .thumb{display:none}.links{gap:16px}}
`;

function shell({ title, description, canonical, image, body, jsonld = "", tweets = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#000000">
<meta property="og:site_name" content="Hyperliquid India">
<meta property="og:type" content="${jsonld ? "article" : "website"}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
${image ? `<meta property="og:image" content="${esc(image)}">\n<meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`}
<link rel="alternate" type="application/rss+xml" title="Hyperliquid India" href="${FEED_URL}">
<link rel="icon" type="image/svg+xml" href="/home/hl-mark.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@1,6..72,200..800&display=swap">
<style>${CSS}</style>
${jsonld ? `<script type="application/ld+json">${jsonld.replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body>
<header class="nav"><div class="wrap">
<a class="brand" href="/home"><img src="/home/hl-mark.svg" alt=""><span>Hyperliquid India</span></a>
<nav class="links"><a href="/home">Home</a><a href="/writing" aria-current="page">Writing</a></nav>
</div></header>
${body}
<footer><div class="wrap">
<p>Hyperliquid India is an independent community of Indian traders and builders on Hyperliquid.</p>
<nav><a href="${SUBSTACK}/archive" target="_blank" rel="noopener">Substack archive</a><a href="${FEED_URL}" target="_blank" rel="noopener">RSS</a></nav>
</div></footer>
${tweets ? '<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>' : ""}
</body>
</html>`;
}

function subscribeBox(pageUrl) {
  return `<section class="sub-box" aria-labelledby="sub-h">
<h2 id="sub-h">New posts by email</h2>
<p>Research and event notes from Hyperliquid India, sent when there is something worth reading.</p>
<form class="sub-form" action="${SUBSTACK}/api/v1/free?nojs=true" method="post" target="_blank">
<input type="email" name="email" placeholder="you@example.com" autocomplete="email" required aria-label="Email address">
<input type="hidden" name="first_url" value="${esc(pageUrl)}"><input type="hidden" name="current_url" value="${esc(pageUrl)}"><input type="hidden" name="source" value="subscribe-page">
<button type="submit">Subscribe</button>
</form></section>`;
}

export function renderIndex(posts) {
  const rows = posts
    .map((p) => {
      const internal = !p.paid;
      const href = internal ? `/writing/${esc(p.slug)}` : esc(p.url);
      const ext = internal ? "" : ' target="_blank" rel="noopener"';
      return `<li><a class="row" href="${href}"${ext}>
<span class="mono">${esc(fmtDate(p.date))}${p.paid ? " &middot; Subscribers on Substack" : ""}</span>
<span><h2>${esc(p.title)}</h2>${p.subtitle ? `<p>${esc(p.subtitle)}</p>` : ""}</span>
${p.cover ? `<span class="thumb" style="background-image:url('${esc(p.cover).replace(/'/g, "%27")}')" role="presentation"></span>` : "<span></span>"}
</a></li>`;
    })
    .join("\n");
  const body = `<main class="wrap">
<div class="head"><h1>Writing</h1><p>Research, event notes and field reports from the Hyperliquid India community.</p></div>
${posts.length ? `<ul class="list">${rows}</ul>` : `<p class="empty">Posts are not loading right now. You can read everything on <a href="${SUBSTACK}/archive">Substack</a>.</p>`}
<div class="col" style="max-width:none">${subscribeBox(`${SITE}/writing`)}</div>
</main>`;
  return shell({
    title: "Writing | Hyperliquid India",
    description: "Research, event notes and field reports from the Hyperliquid India community.",
    canonical: `${SITE}/writing`,
    image: posts.find((p) => p.cover)?.cover,
    body,
  });
}

export function renderPost(post, parsed) {
  const canonical = `${SITE}/writing/${post.slug}`;
  const description = post.subtitle || `${post.title} by Hyperliquid India.`;
  const jsonld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description,
    datePublished: post.date || undefined,
    image: post.cover || undefined,
    mainEntityOfPage: canonical,
    author: { "@type": "Organization", name: "Hyperliquid India" },
    publisher: { "@type": "Organization", name: "Hyperliquid India", url: SITE },
  });
  const body = `<main class="wrap"><article class="col">
<a class="back" href="/writing">&larr; All writing</a>
<header class="post-head">
<div class="mono">${esc(fmtDate(post.date))} &middot; ${readMinutes(parsed.words)} min read</div>
<h1>${esc(post.title)}</h1>
${post.subtitle ? `<p class="sub">${esc(post.subtitle)}</p>` : ""}
</header>
<div class="prose">${parsed.html}</div>
${subscribeBox(canonical)}
</article></main>`;
  return shell({ title: `${post.title} | Hyperliquid India`, description, canonical, image: post.cover, body, jsonld, tweets: parsed.hasTweets });
}

export function renderNotFound() {
  return shell({
    title: "Not found | Hyperliquid India",
    description: "That post could not be found.",
    canonical: `${SITE}/writing`,
    body: `<main class="wrap"><div class="head"><h1>Post not found</h1><p>It may have moved. <a href="/writing">See all writing</a>.</p></div></main>`,
  });
}
