/* ============================================================
   scraper.js — best-effort product scraping for e-commerce
   clients. Fetches the homepage + a likely /products page and
   tries multiple heuristics. Returns an array of {title, price,
   image, url, description}.

   This is intentionally simple. It works on Shopify/WooCommerce
   templates and most basic catalog pages. It WILL fail on
   JS-rendered SPAs (no DOM in the HTML) and on heavily protected
   sites — that's expected.

   Results are cached in client.productsCache for 24 hours.
============================================================ */

const axios   = require("axios");
const cheerio = require("cheerio");

const CACHE_TTL_MS    = 24 * 60 * 60 * 1000;  // 24 hours
const USER_AGENT      = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const FETCH_TIMEOUT   = 15000;
const MAX_PRODUCTS    = 20;

/* ============================================================
   Fetch a URL and return parsed HTML
============================================================ */

async function fetchHtml(url) {

    const r = await axios.get(url, {
        timeout:        FETCH_TIMEOUT,
        maxRedirects:   5,
        responseType:   "text",
        headers: {
            "User-Agent":      USER_AGENT,
            "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9",
            "Accept-Language": "en-US,en;q=0.9"
        },
        validateStatus: s => s >= 200 && s < 400
    });

    return cheerio.load(r.data);
}

function absUrl(base, href) {
    if (!href) return "";
    try { return new URL(href, base).toString(); }
    catch (_) { return ""; }
}

function cleanText(s) {
    return (s || "")
        .replace(/\s+/g, " ")
        .replace(/\u00a0/g, " ")
        .trim()
        .slice(0, 300);
}

// Strip HTML tags from a string without needing a Cheerio instance.
// Used for Shopify product body_html, which is raw HTML.
function stripHtml(html) {
    return String(html || "")
        .replace(/<[^>]*>/g, " ")   // remove tags
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function looksLikePrice(s) {
    if (!s) return false;
    return /[$€£₹¥]|rs\.?\s*\d|\bINR\b|\bUSD\b|\bprice\b/i.test(s) && /\d/.test(s);
}

/* ============================================================
   Extract products from a parsed page using multiple strategies
   in order. First strategy to yield ≥3 items wins.
============================================================ */

function extractProducts($, baseUrl) {

    const found = new Map();   // dedup by title

    /* ---------- Strategy 1: schema.org Product / JSON-LD ---------- */

    $('script[type="application/ld+json"]').each((_, el) => {

        try {

            const txt = $(el).contents().text();
            const parsed = JSON.parse(txt);
            const arr = Array.isArray(parsed) ? parsed : [parsed];

            for (const obj of arr) {

                const items = obj["@graph"] || [obj];

                for (const it of items) {

                    const type = it["@type"];
                    const isProduct =
                        type === "Product" ||
                        (Array.isArray(type) && type.includes("Product"));

                    if (!isProduct) continue;

                    const title = cleanText(it.name);
                    if (!title) continue;

                    const price =
                        cleanText(it.offers?.price ||
                                  it.offers?.priceSpecification?.price ||
                                  it.offers?.lowPrice ||
                                  "");

                    const image = Array.isArray(it.image)
                        ? it.image[0]
                        : (it.image?.url || it.image || "");

                    found.set(title.toLowerCase(), {
                        title,
                        price: price ? String(price) : "",
                        image: absUrl(baseUrl, image),
                        url:   absUrl(baseUrl, it.url || ""),
                        description: cleanText(it.description || "")
                    });
                }
            }

        } catch (_) {}
    });

    if (found.size >= 3) return [...found.values()].slice(0, MAX_PRODUCTS);

    /* ---------- Strategy 2: Shopify /products.json — handled separately --- */

    /* ---------- Strategy 3: HTML heuristics ---------- */

    const candidateSelectors = [
        '.product-card', '.product-item', '.product',
        'li.product', 'article.product',
        '[class*="ProductCard"]', '[class*="product-grid-item"]',
        '[data-product]', '[data-product-id]'
    ];

    for (const sel of candidateSelectors) {

        const blocks = $(sel);
        if (!blocks.length) continue;

        blocks.each((_, el) => {

            const $el = $(el);

            const title =
                cleanText($el.find('h1,h2,h3,h4,.product-title,[class*="title"]').first().text()) ||
                cleanText($el.find('a').first().text());

            if (!title || found.has(title.toLowerCase())) return;

            let price = "";
            $el.find('*').each((_, c) => {
                const t = $(c).text();
                if (looksLikePrice(t) && t.length < 60) {
                    price = cleanText(t);
                    return false;
                }
            });

            const imgSrc =
                $el.find('img').attr('src') ||
                $el.find('img').attr('data-src') ||
                "";

            const link = $el.find('a').attr('href') || "";

            found.set(title.toLowerCase(), {
                title,
                price,
                image: absUrl(baseUrl, imgSrc),
                url:   absUrl(baseUrl, link),
                description: ""
            });

            if (found.size >= MAX_PRODUCTS) return false;
        });

        if (found.size >= 3) break;
    }

    return [...found.values()].slice(0, MAX_PRODUCTS);
}

/* ============================================================
   Try WooCommerce Store API (WordPress sites)
   Returns clean product JSON when the site is WooCommerce with
   the Store API enabled (most modern WooCommerce installs).
============================================================ */

async function tryWooCommerceJSON(baseUrl) {

    // The Store API lives under the WP REST root. baseUrl may be the shop
    // page (e.g. https://site.com/rgsaga/shop/) — derive the WP root by
    // stripping the trailing shop/store path segment.
    const roots = [];
    try {
        const u = new URL(baseUrl);
        // Try the full path root and progressively shorter parents so a
        // sub-install like /rgsaga/ is covered as well as the domain root.
        const segs = u.pathname.split("/").filter(Boolean);
        // Drop a trailing "shop"/"store"/"products" segment if present
        if (segs.length && /^(shop|store|products|collections)$/i.test(segs[segs.length - 1])) {
            segs.pop();
        }
        // Build candidate roots: /rgsaga/ then /
        for (let i = segs.length; i >= 0; i--) {
            const path = "/" + segs.slice(0, i).join("/");
            roots.push(new URL((path.endsWith("/") ? path : path + "/"), u.origin).toString());
        }
    } catch (_) {
        return [];
    }

    for (const root of roots) {

        const url = root.replace(/\/$/, "") + "/wp-json/wc/store/v1/products?per_page=" + MAX_PRODUCTS;

        try {
            const r = await axios.get(url, {
                timeout:      FETCH_TIMEOUT,
                headers:      { "User-Agent": USER_AGENT, "Accept": "application/json" },
                validateStatus: s => s >= 200 && s < 300
            });

            if (Array.isArray(r.data) && r.data.length) {
                return r.data.slice(0, MAX_PRODUCTS).map(p => ({
                    title:       cleanText(p.name),
                    price:       extractWooPrice(p),
                    image:       p.images?.[0]?.src || "",
                    url:         p.permalink || "",
                    description: cleanText(stripHtml(p.short_description || p.description || "")).slice(0, 300)
                })).filter(x => x.title);
            }
        } catch (_) { /* try next root */ }
    }

    return [];
}

// WooCommerce Store API returns prices as minor units (e.g. "12500" with
// currency_minor_unit=2 → 125.00) plus a formatted `price_html`.
function extractWooPrice(p) {
    const pr = p.prices;
    if (!pr) return "";
    const minor = parseInt(pr.currency_minor_unit ?? 2, 10);
    const raw   = pr.price;
    if (raw == null || raw === "") return "";
    const num = Number(raw) / Math.pow(10, minor);
    if (Number.isNaN(num)) return String(raw);
    const symbol = pr.currency_symbol || pr.currency_prefix || "";
    return (symbol ? symbol : "") + num.toFixed(2);
}

/* ============================================================
   Try Shopify's public products.json endpoint
============================================================ */


async function tryShopifyJSON(baseUrl) {

    const url = new URL("/products.json?limit=20", baseUrl).toString();

    try {

        const r = await axios.get(url, {
            timeout:      FETCH_TIMEOUT,
            headers:      { "User-Agent": USER_AGENT },
            validateStatus: s => s >= 200 && s < 300
        });

        if (!r.data?.products) return [];

        return r.data.products.slice(0, MAX_PRODUCTS).map(p => ({
            title:       cleanText(p.title),
            price:       p.variants?.[0]?.price ? String(p.variants[0].price) : "",
            image:       p.images?.[0]?.src || "",
            url:         absUrl(baseUrl, "/products/" + p.handle),
            description: cleanText(stripHtml(p.body_html || "")).slice(0, 300)
        }));

    } catch (_) {

        return [];
    }
}

/* ============================================================
   Public API: scrape one website
============================================================ */

async function scrapeWebsite(websiteUrl, opts = {}) {

    const explicitPages = Array.isArray(opts.extraPages)
        ? opts.extraPages.filter(u => /^https?:\/\//i.test(String(u || "").trim()))
        : [];

    // Need at least one usable URL — either a website or an explicit shop page.
    const baseForShopify = websiteUrl && /^https?:\/\//i.test(websiteUrl)
        ? websiteUrl
        : explicitPages[0];

    if (!baseForShopify) {
        return { items: [], source: "none", error: "Invalid URL" };
    }

    const all  = [];
    const seen = new Set();

    function addItems(items) {
        for (const p of items) {
            const key = (p.title || "").toLowerCase();
            if (key && !seen.has(key)) { seen.add(key); all.push(p); }
        }
    }

    /* ---- 0. Scrape EXPLICIT shop pages first (highest priority) ---- */

    for (const page of explicitPages) {

        // Try WooCommerce Store API, then Shopify JSON, then HTML.
        try {
            const woo = await tryWooCommerceJSON(page);
            if (woo.length) addItems(woo);
        } catch (_) {}

        if (all.length < MAX_PRODUCTS) {
            try {
                const shop = await tryShopifyJSON(page);
                if (shop.length) addItems(shop);
            } catch (_) {}
        }

        if (all.length < MAX_PRODUCTS) {
            try {
                const $ = await fetchHtml(page);
                addItems(extractProducts($, page));
            } catch (e) {
                console.log(`scraper: explicit page failed (${page}):`, e.message);
            }
        }

        if (all.length >= MAX_PRODUCTS) break;
    }

    // If explicit pages already gave us products, we're done.
    if (all.length) {
        return { items: all.slice(0, MAX_PRODUCTS), source: "shop-pages" };
    }

    /* 1. Try WooCommerce Store API, then Shopify JSON, on the website root */

    try {
        const woo = await tryWooCommerceJSON(baseForShopify);
        if (woo.length) {
            return { items: woo, source: "woocommerce-json" };
        }
    } catch (_) {}

    try {

        const shop = await tryShopifyJSON(baseForShopify);
        if (shop.length) {
            return { items: shop, source: "shopify-json" };
        }

    } catch (_) {}

    // No website root to crawl further — explicit pages were the only source.
    if (!websiteUrl || !/^https?:\/\//i.test(websiteUrl)) {
        return { items: [], source: "scrape-empty" };
    }

    /* 2. Fetch homepage and scrape */

    let homepageItems = [];

    try {

        const $ = await fetchHtml(websiteUrl);
        homepageItems = extractProducts($, websiteUrl);

    } catch (e) {

        console.log("scraper: homepage fetch failed:", e.message);
    }

    /* 3. Also try the most likely product index pages */

    const productPaths = [
        "/products", "/shop", "/collections/all",
        "/store", "/catalog", "/all-products"
    ];

    if (homepageItems.length < 3) {

        for (const path of productPaths) {

            try {

                const url = new URL(path, websiteUrl).toString();
                const $   = await fetchHtml(url);
                const items = extractProducts($, url);

                if (items.length) {

                    // Dedup with anything found on homepage
                    const seen = new Set(homepageItems.map(p => p.title.toLowerCase()));
                    for (const p of items) {
                        if (!seen.has(p.title.toLowerCase())) {
                            homepageItems.push(p);
                            seen.add(p.title.toLowerCase());
                        }
                    }

                    if (homepageItems.length >= 5) break;
                }

            } catch (_) {}
        }
    }

    if (!homepageItems.length) {
        return { items: [], source: "scrape-empty" };
    }

    return { items: homepageItems.slice(0, MAX_PRODUCTS), source: "scrape" };
}

/* ============================================================
   Cached wrapper — uses Client.productsCache, refreshes if
   stale (>24h) or if forced.
============================================================ */

async function getProductsForClient(client, opts = {}) {

    const cache = client.productsCache;
    const age   = cache?.scrapedAt
        ? Date.now() - new Date(cache.scrapedAt).getTime()
        : Infinity;

    if (!opts.force && cache?.items?.length && age < CACHE_TTL_MS) {
        return { items: cache.items, source: cache.source, fromCache: true };
    }

    const extraPages = Array.isArray(client.shopPages) ? client.shopPages : [];

    if (!client.website && !extraPages.length) {
        return { items: [], source: "no-website" };
    }

    const result = await scrapeWebsite(client.website, { extraPages });
    return { ...result, fromCache: false };
}

module.exports = { scrapeWebsite, getProductsForClient };
