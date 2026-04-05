import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());

// ─────────────────────────────────────────────────────────────────────────────
// API Key — stored server-side via environment variable
// ─────────────────────────────────────────────────────────────────────────────
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ─────────────────────────────────────────────────────────────────────────────

function normalizeName(value = "") {
  return value.toLowerCase()
    .replace(/&/g, " and ").replace(/@/g, " ").replace(/saint/g, "st")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(value = "") {
  return new Set(normalizeName(value).split(" ").filter(Boolean));
}

function overlapScore(a = "", b = "") {
  const A = tokenSet(a);
  const B = tokenSet(b);
  let overlap = 0;
  for (const t of A) {
    if (B.has(t)) { overlap += 1; continue; }
    // Fuzzy: check if token is a prefix/substring of any other token (min 4 chars)
    // Handles "rennes" matching "rennais", "brest" matching "brestois", etc.
    if (t.length >= 4) {
      for (const bt of B) {
        if (bt.length >= 4 && (bt.startsWith(t.slice(0, 4)) || t.startsWith(bt.slice(0, 4)))) {
          overlap += 0.75; break;
        }
      }
    }
  }
  return overlap;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "BettingAggregator/1.0", "Accept": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      console.warn(`[fetchJson] Non-JSON from ${url}: ${text.slice(0, 200)}`);
      return null;
    }
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache — 2 hour TTL
// ─────────────────────────────────────────────────────────────────────────────

const resolverCache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 min cache

function cacheGet(key) {
  const entry = resolverCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { resolverCache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value) {
  resolverCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
}

// ─────────────────────────────────────────────────────────────────────────────
// DraftKings — sport-specific game lines pages
// (DK API is blocked by Akamai CDN; search engines detect bots.
//  Deep links come from The Odds API includeLinks on the frontend.)
// ─────────────────────────────────────────────────────────────────────────────

const DK_LEAGUE_URLS = {
  basketball_nba: "https://sportsbook.draftkings.com/leagues/basketball/nba?category=game-lines&subcategory=game",
  americanfootball_nfl: "https://sportsbook.draftkings.com/leagues/football/nfl?category=game-lines&subcategory=game",
  baseball_mlb: "https://sportsbook.draftkings.com/leagues/baseball/mlb?category=game-lines&subcategory=game",
  icehockey_nhl: "https://sportsbook.draftkings.com/leagues/hockey/nhl?category=game-lines&subcategory=game",
  basketball_ncaab: "https://sportsbook.draftkings.com/leagues/basketball/ncaab?category=game-lines&subcategory=game",
  mma_mixed_martial_arts: "https://sportsbook.draftkings.com/leagues/mma/ufc",
  soccer_epl: "https://sportsbook.draftkings.com/leagues/soccer/epl",
  soccer_spain_la_liga: "https://sportsbook.draftkings.com/leagues/soccer/la-liga",
  soccer_italy_serie_a: "https://sportsbook.draftkings.com/leagues/soccer/italy-serie-a",
  soccer_germany_bundesliga: "https://sportsbook.draftkings.com/leagues/soccer/bundesliga",
  soccer_france_ligue_one: "https://sportsbook.draftkings.com/leagues/soccer/france-ligue-1",
};

function resolveDraftKings(sportKey) {
  const leagueUrl = DK_LEAGUE_URLS[sportKey] || "https://sportsbook.draftkings.com/";
  return {
    ok: true, book: "DraftKings", exactEventUrl: null,
    routeType: "league", finalUrl: leagueUrl, fallbackLeagueUrl: leagueUrl,
    note: "Sport game lines page — deep links provided by Odds API on frontend"
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FanDuel — sport-specific navigation pages
// ─────────────────────────────────────────────────────────────────────────────

const FD_LEAGUE_URLS = {
  basketball_nba: "https://sportsbook.fanduel.com/navigation/nba",
  americanfootball_nfl: "https://sportsbook.fanduel.com/navigation/nfl",
  baseball_mlb: "https://sportsbook.fanduel.com/navigation/mlb",
  icehockey_nhl: "https://sportsbook.fanduel.com/navigation/nhl",
  basketball_ncaab: "https://sportsbook.fanduel.com/navigation/ncaab",
  mma_mixed_martial_arts: "https://sportsbook.fanduel.com/navigation/ufc-mma",
  soccer_epl: "https://sportsbook.fanduel.com/navigation/soccer",
  soccer_spain_la_liga: "https://sportsbook.fanduel.com/navigation/soccer",
  soccer_italy_serie_a: "https://sportsbook.fanduel.com/navigation/soccer",
  soccer_germany_bundesliga: "https://sportsbook.fanduel.com/navigation/soccer",
  soccer_france_ligue_one: "https://sportsbook.fanduel.com/navigation/soccer",
};

function resolveFanDuel(sportKey) {
  const leagueUrl = FD_LEAGUE_URLS[sportKey] || "https://sportsbook.fanduel.com/";
  return {
    ok: true, book: "FanDuel", exactEventUrl: null,
    routeType: "league", finalUrl: leagueUrl, fallbackLeagueUrl: leagueUrl,
    note: "Sport navigation page — deep links provided by Odds API on frontend"
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi — public REST API (no auth for market data reads)
// This is the only bookmaker we can resolve server-side to exact event links
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const KALSHI_SERIES = {
  basketball_nba: "KXNBAGAME",
  americanfootball_nfl: "KXNFLGAME",
  baseball_mlb: "KXMLBGAME",
  icehockey_nhl: "KXNHLGAME",
  basketball_ncaab: "KXNCAABGAME",
  mma_mixed_martial_arts: "KXUFCFIGHT",
  // Soccer leagues
  soccer_epl: "KXEPLGAME",
  soccer_spain_la_liga: "KXLALIGAGAME",
  soccer_italy_serie_a: "KXSERIEAGAME",
  soccer_germany_bundesliga: "KXBUNDESLIGAGAME",
  soccer_france_ligue_one: "KXLIGUE1GAME",
};

const KALSHI_LEAGUE_URLS = {
  basketball_nba: "https://kalshi.com/sports/nba",
  americanfootball_nfl: "https://kalshi.com/sports/nfl",
  baseball_mlb: "https://kalshi.com/sports/mlb",
  icehockey_nhl: "https://kalshi.com/sports/nhl",
  basketball_ncaab: "https://kalshi.com/sports/ncaab",
  mma_mixed_martial_arts: "https://kalshi.com/sports/ufc",
  // Soccer leagues
  soccer_epl: "https://kalshi.com/category/sports/soccer",
  soccer_spain_la_liga: "https://kalshi.com/category/sports/soccer",
  soccer_italy_serie_a: "https://kalshi.com/category/sports/soccer",
  soccer_germany_bundesliga: "https://kalshi.com/category/sports/soccer",
  soccer_france_ligue_one: "https://kalshi.com/category/sports/soccer",
};

const KALSHI_SPORT_SLUG = {
  basketball_nba: "professional-basketball-game",
  americanfootball_nfl: "professional-football-game",
  baseball_mlb: "professional-baseball-game",
  icehockey_nhl: "professional-hockey-game",
  basketball_ncaab: "college-basketball-game",
  mma_mixed_martial_arts: "ufc-fight",
  // Soccer leagues
  soccer_epl: "english-premier-league-game",
  soccer_spain_la_liga: "la-liga-game",
  soccer_italy_serie_a: "serie-a-game",
  soccer_germany_bundesliga: "bundesliga-game",
  soccer_france_ligue_one: "ligue-1-game",
};

async function resolveKalshi(sportKey, home, away) {
  const cacheKey = `kalshi:${sportKey}:${normalizeName(away)}:${normalizeName(home)}`;
  const cached = cacheGet(cacheKey);
  if (cached) { console.log(`[Kalshi] Cache hit: ${cacheKey}`); return cached; }

  const seriesTicker = KALSHI_SERIES[sportKey];
  const leagueUrl = KALSHI_LEAGUE_URLS[sportKey] || "https://kalshi.com/sports/all-sports";

  if (seriesTicker) {
    try {
      const apiUrl = `${KALSHI_API_BASE}/events?series_ticker=${seriesTicker}&with_nested_markets=true&status=open&limit=200`;
      console.log(`[Kalshi] Fetching: ${apiUrl}`);
      const data = await fetchJson(apiUrl);
      const events = data?.events || [];
      console.log(`[Kalshi] Found ${events.length} open events`);

      if (events.length) {
        const scored = events
          .map(ev => {
            const text = [ev.title, ev.sub_title, ev.event_ticker, ev.category].filter(Boolean).join(" ").toLowerCase();
            const score = overlapScore(text, away) + overlapScore(text, home);
            return { ev, score };
          })
          .filter(x => x.score >= 1.5)
          .sort((a, b) => b.score - a.score);

        if (scored.length) {
          const best = scored[0].ev;
          const ticker = best.event_ticker || "";
          const sportSlug = KALSHI_SPORT_SLUG[sportKey] || "game";
          const seriesLower = seriesTicker.toLowerCase();
          const eventUrl = `https://kalshi.com/markets/${seriesLower}/${sportSlug}/${ticker}`;

          console.log(`[Kalshi] ✓ Matched: "${best.title}" → ${eventUrl}`);
          const result = {
            ok: true, book: "Kalshi",
            exactEventUrl: eventUrl, routeType: "event", finalUrl: eventUrl,
            fallbackLeagueUrl: leagueUrl, note: `Matched: ${best.title}`
          };
          cacheSet(cacheKey, result);
          return result;
        }
      }
    } catch (err) {
      console.warn(`[Kalshi] API failed: ${err.message}`);
    }
  }

  console.log(`[Kalshi] ✗ No match, using league fallback`);
  const result = {
    ok: true, book: "Kalshi", exactEventUrl: null,
    routeType: "league", finalUrl: leagueUrl, fallbackLeagueUrl: leagueUrl,
    note: "League page fallback"
  };
  cacheSet(cacheKey, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// API routes
// ─────────────────────────────────────────────────────────────────────────────

// Proxy to The Odds API — forwards includeLinks and includeSids
// API key is stored server-side; client no longer needs to provide it
app.get("/api/odds/:sport", async (req, res) => {
  const sport = req.params.sport;
  const apiKey = ODDS_API_KEY || req.query.apiKey;
  if (!apiKey) return res.status(400).json({ error: "No API key configured. Set ODDS_API_KEY env var on server." });

  const search = new URLSearchParams({
    apiKey, regions: req.query.regions || "us", markets: "h2h", oddsFormat: "american",
    includeLinks: "true", includeSids: "true"
  });
  if (req.query.bookmakers) search.set("bookmakers", req.query.bookmakers);

  try {
    const response = await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds/?${search.toString()}`);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(500).json({ error: "Non-JSON from Odds API", raw: text.slice(0, 500) });
    }
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch odds", details: err.message });
  }
});

// Unified resolver — Kalshi gets direct event links, DK/FD get sport pages
app.get("/api/resolve-all", async (req, res) => {
  const { sportKey = "", league = "", home = "", away = "" } = req.query;
  if (!sportKey || !home || !away) {
    return res.status(400).json({ error: "Missing params", required: ["sportKey", "home", "away"] });
  }

  console.log(`\n[RESOLVE] ${away} @ ${home} (${sportKey})`);

  // Kalshi resolves via API; DK/FD are instant (league pages)
  const kalshiResult = await resolveKalshi(sportKey, home, away);

  return res.json({
    ok: true, home, away, league, sportKey,
    bookmakers: {
      draftkings: resolveDraftKings(sportKey),
      fanduel:    resolveFanDuel(sportKey),
      kalshi:     kalshiResult,
    }
  });
});

// Individual resolvers
app.get("/api/kalshi-resolve", async (req, res) => {
  const { sportKey = "", home = "", away = "" } = req.query;
  if (!sportKey || !home || !away) return res.status(400).json({ error: "Missing params" });
  const result = await resolveKalshi(sportKey, home, away);
  return res.json(result);
});

app.get("/api/draftkings-resolve", (req, res) => {
  res.json(resolveDraftKings(req.query.sportKey || ""));
});

app.get("/api/fanduel-resolve", (req, res) => {
  res.json(resolveFanDuel(req.query.sportKey || ""));
});

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi non-sports categories — Politics, Crypto, Climate, Economics, Culture
// These are pure prediction markets (binary yes/no contracts)
// ─────────────────────────────────────────────────────────────────────────────

const KALSHI_CATEGORIES = {
  politics: {
    label: "Politics",
    seriesTickers: ["KXPRESPARTY", "KXSENATE", "KXHOUSE", "KXPRESWIN"],
    fallbackUrl: "https://kalshi.com/category/politics",
    searchTerms: ["president", "congress", "senate", "election", "governor", "political", "democrat", "republican", "trump", "biden"]
  },
  elections: {
    label: "Elections",
    seriesTickers: ["KXPRESPARTY", "KXPRESWIN", "KXSENATE", "KXHOUSE", "KXGOV"],
    fallbackUrl: "https://kalshi.com/category/elections",
    searchTerms: ["election", "vote", "ballot", "primary", "electoral", "midterm", "2026", "2028", "runoff", "special election"]
  },
  crypto: {
    label: "Crypto",
    seriesTickers: ["KXBTC", "KXETH", "KXBTCUSD", "KXETHUSD", "KXBTCD", "KXETHD"],
    fallbackUrl: "https://kalshi.com/category/crypto",
    searchTerms: ["bitcoin", "ethereum", "crypto", "btc", "eth", "solana"]
  },
  climate: {
    label: "Climate",
    seriesTickers: ["KXHIGHNY", "KXHIGHCHI", "KXHIGHLA", "KXHIGHMIA", "KXHURRICANE"],
    fallbackUrl: "https://kalshi.com/category/climate",
    searchTerms: ["temperature", "hurricane", "weather", "climate", "wildfire", "rainfall"]
  },
  economics: {
    label: "Economics",
    seriesTickers: ["KXFED", "KXCPI", "KXGDP", "KXUNRATE", "KXJOBS", "KXINFL", "KXRECESSION"],
    fallbackUrl: "https://kalshi.com/category/economics",
    searchTerms: ["fed", "inflation", "gdp", "unemployment", "recession", "interest rate", "cpi", "jobs", "economic"]
  },
  financials: {
    label: "Financials",
    seriesTickers: ["KXSPY", "KXNAS", "KXDOW", "KXVIX", "KXSPX", "KXNDX"],
    fallbackUrl: "https://kalshi.com/category/financials",
    searchTerms: ["stock", "s&p", "nasdaq", "dow", "market", "index", "equity", "share price", "vix", "treasury", "yield", "bond"]
  },
  companies: {
    label: "Companies",
    seriesTickers: ["KXAAPL", "KXGOOG", "KXMSFT", "KXTSLA", "KXAMZN", "KXNVDA", "KXMETA"],
    fallbackUrl: "https://kalshi.com/category/companies",
    searchTerms: ["apple", "google", "microsoft", "tesla", "amazon", "nvidia", "meta", "earnings", "revenue", "ipo", "stock price", "market cap"]
  },
  techscience: {
    label: "Tech & Science",
    seriesTickers: ["KXAI", "KXSPACEX", "KXFDA"],
    fallbackUrl: "https://kalshi.com/category/tech-and-science",
    searchTerms: ["ai", "artificial intelligence", "spacex", "nasa", "launch", "fda", "tech", "science", "robotics", "quantum", "regulation"]
  },
  culture: {
    label: "Culture",
    seriesTickers: ["KXOSCARS", "KXGRAMMYS", "KXEMMYS"],
    fallbackUrl: "https://kalshi.com/category/culture",
    searchTerms: ["oscars", "grammys", "emmys", "awards", "movie", "music", "entertainment"]
  },
  mentions: {
    label: "Mentions",
    seriesTickers: ["KXTRUMP", "KXELON", "KXBIDEN"],
    fallbackUrl: "https://kalshi.com/category/mentions",
    searchTerms: ["mention", "tweet", "truth social", "speech", "press conference", "interview", "said", "statement"]
  }
};

// Fetch Kalshi events for a non-sports category
app.get("/api/kalshi-category/:category", async (req, res) => {
  const catKey = req.params.category.toLowerCase();
  const catConfig = KALSHI_CATEGORIES[catKey];
  if (!catConfig) {
    return res.status(400).json({ error: `Unknown category: ${catKey}`, available: Object.keys(KALSHI_CATEGORIES) });
  }

  const cacheKey = `kalshi-cat:${catKey}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[Kalshi-Cat] Cache hit: ${catKey}`);
    return res.json(cached);
  }

  console.log(`[Kalshi-Cat] Fetching category: ${catConfig.label}`);
  const allEvents = [];

  // Strategy 1: Fetch by known series tickers
  for (const ticker of catConfig.seriesTickers) {
    try {
      const url = `${KALSHI_API_BASE}/events?series_ticker=${ticker}&with_nested_markets=true&status=open&limit=100`;
      const data = await fetchJson(url);
      const events = data?.events || [];
      console.log(`[Kalshi-Cat] ${ticker}: ${events.length} events`);
      allEvents.push(...events);
    } catch (err) {
      console.warn(`[Kalshi-Cat] ${ticker} failed: ${err.message}`);
    }
  }

  // Strategy 2: If we got few results, do paginated broad search
  if (allEvents.length < 5) {
    const terms = catConfig.searchTerms;
    const existingTickers = new Set(allEvents.map(e => e.event_ticker));
    let cursor = null;
    let pages = 0;
    const maxPages = 5; // up to 1000 events scanned

    while (pages < maxPages) {
      try {
        let url = `${KALSHI_API_BASE}/events?with_nested_markets=true&status=open&limit=200`;
        if (cursor) url += `&cursor=${cursor}`;
        const data = await fetchJson(url);
        const events = data?.events || [];
        if (events.length === 0) break;

        const filtered = events.filter(ev => {
          const text = [ev.title, ev.sub_title, ev.category, ev.event_ticker, ev.series_ticker].filter(Boolean).join(" ").toLowerCase();
          return terms.some(term => text.includes(term));
        });
        for (const ev of filtered) {
          if (!existingTickers.has(ev.event_ticker)) {
            allEvents.push(ev);
            existingTickers.add(ev.event_ticker);
          }
        }
        console.log(`[Kalshi-Cat] Broad page ${pages + 1}: ${filtered.length} matching from ${events.length} (total so far: ${allEvents.length})`);

        cursor = data?.cursor || null;
        if (!cursor) break;
        pages++;
      } catch (err) {
        console.warn(`[Kalshi-Cat] Broad search page ${pages + 1} failed: ${err.message}`);
        break;
      }
    }
  }

  // Helper: extract price in cents from Kalshi market object
  // Kalshi migrated to _dollars fields (March 2026); legacy integer fields removed
  function priceCents(market, field) {
    // Try _dollars field first (current API), convert to cents
    const dVal = market[field + "_dollars"];
    if (dVal != null && dVal !== 0) return Math.round(dVal * 100);
    // Fallback to legacy integer field (pre-March 2026)
    const iVal = market[field];
    if (iVal != null && iVal !== 0) return iVal;
    return null;
  }

  // Transform events into a clean response format
  const markets = allEvents.map(ev => {
    const nestedMarkets = ev.markets || [];
    const topMarket = nestedMarkets[0] || {};
    // Build Kalshi event URL
    const ticker = ev.event_ticker || "";
    const seriesTicker = ev.series_ticker || "";
    const eventUrl = ticker
      ? `https://kalshi.com/markets/${seriesTicker.toLowerCase()}/${ticker}`
      : catConfig.fallbackUrl;

    // Determine if this is a multi-outcome event
    const isMultiOutcome = nestedMarkets.length > 1;

    const yesPrice = priceCents(topMarket, "yes_ask");
    const noPrice = priceCents(topMarket, "no_ask");
    const lastPrice = priceCents(topMarket, "last_price");

    return {
      id: ev.event_ticker,
      title: ev.title || "Untitled",
      subtitle: ev.sub_title || "",
      category: ev.category || catConfig.label,
      seriesTicker: ev.series_ticker || "",
      status: ev.status,
      isMultiOutcome,
      yesPrice: yesPrice ?? lastPrice,
      noPrice: noPrice ?? (lastPrice != null ? 100 - lastPrice : null),
      lastPrice,
      volume: topMarket.volume || 0,
      volume24h: topMarket.volume_24h || 0,
      openInterest: topMarket.open_interest || 0,
      expirationDate: topMarket.expiration_time || ev.expected_expiration_time || null,
      eventUrl,
      marketsCount: nestedMarkets.length,
      allMarkets: nestedMarkets.map(m => {
        const yp = priceCents(m, "yes_ask");
        const np = priceCents(m, "no_ask");
        const lp = priceCents(m, "last_price");
        return {
          ticker: m.ticker,
          title: m.title || m.subtitle || "",
          yesPrice: yp ?? lp,
          noPrice: np ?? (lp != null ? 100 - lp : null),
          lastPrice: lp,
          volume: m.volume || 0,
          volume24h: m.volume_24h || 0,
        };
      })
    };
  });

  // Sort by volume descending
  markets.sort((a, b) => (b.volume24h + b.volume) - (a.volume24h + a.volume));

  const result = {
    ok: true,
    category: catConfig.label,
    count: markets.length,
    fallbackUrl: catConfig.fallbackUrl,
    markets
  };

  cacheSet(cacheKey, result);
  return res.json(result);
});

// List available non-sports categories
app.get("/api/kalshi-categories", (req, res) => {
  const cats = Object.entries(KALSHI_CATEGORIES).map(([key, val]) => ({
    key,
    label: val.label,
    url: val.fallbackUrl,
    seriesTickers: val.seriesTickers
  }));
  res.json({ ok: true, categories: cats });
});

// Discover all active series tickers + categories from Kalshi
app.get("/api/kalshi-discover", async (req, res) => {
  const seriesMap = {};
  const categoryMap = {};
  let cursor = null;
  let pages = 0;
  let totalEvents = 0;
  const maxPages = parseInt(req.query.pages) || 10;

  while (pages < maxPages) {
    try {
      let url = `${KALSHI_API_BASE}/events?with_nested_markets=false&status=open&limit=200`;
      if (cursor) url += `&cursor=${cursor}`;
      const data = await fetchJson(url);
      const events = data?.events || [];
      if (events.length === 0) break;
      totalEvents += events.length;

      for (const ev of events) {
        const st = ev.series_ticker || "NONE";
        const cat = ev.category || "Uncategorized";
        if (!seriesMap[st]) seriesMap[st] = { count: 0, category: cat, sampleTitle: ev.title };
        seriesMap[st].count++;
        if (!categoryMap[cat]) categoryMap[cat] = { count: 0, series: new Set() };
        categoryMap[cat].count++;
        categoryMap[cat].series.add(st);
      }

      cursor = data?.cursor || null;
      if (!cursor) break;
      pages++;
    } catch (err) {
      break;
    }
  }

  // Convert sets to arrays for JSON
  for (const cat of Object.values(categoryMap)) {
    cat.series = [...cat.series];
  }

  // Sort series by count descending
  const sorted = Object.entries(seriesMap).sort((a, b) => b[1].count - a[1].count);

  return res.json({
    ok: true, totalEvents, pagesScanned: pages + 1,
    categories: categoryMap,
    topSeries: sorted.slice(0, 50).map(([ticker, info]) => ({
      ticker, count: info.count, category: info.category, sample: info.sampleTitle
    }))
  });
});

// Raw Kalshi debug — shows actual field names from API response
app.get("/api/kalshi-raw", async (req, res) => {
  const ticker = req.query.series || "KXPRESPARTY";
  try {
    const url = `${KALSHI_API_BASE}/events?series_ticker=${ticker}&with_nested_markets=true&status=open&limit=2`;
    const data = await fetchJson(url);
    const events = data?.events || [];
    const sample = events.slice(0, 1).map(ev => ({
      event_ticker: ev.event_ticker,
      title: ev.title,
      category: ev.category,
      series_ticker: ev.series_ticker,
      market_count: (ev.markets || []).length,
      first_market_keys: ev.markets?.[0] ? Object.keys(ev.markets[0]) : [],
      first_market_raw: ev.markets?.[0] || null,
    }));
    return res.json({ ok: true, ticker, eventCount: events.length, sample });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

// Debug endpoint
app.get("/api/debug", async (req, res) => {
  const sportKey = req.query.sportKey || "basketball_nba";
  const debug = { sportKey, timestamp: new Date().toISOString(), results: {} };

  // Kalshi — the only live API call
  const kalshiTicker = KALSHI_SERIES[sportKey];
  if (kalshiTicker) {
    try {
      const url = `${KALSHI_API_BASE}/events?series_ticker=${kalshiTicker}&with_nested_markets=true&status=open&limit=5`;
      const data = await fetchJson(url);
      const events = data?.events || [];
      debug.results.kalshi = {
        url, status: "ok",
        eventsFound: events.length,
        sampleEvents: events.slice(0, 3).map(e => ({
          title: e.title, event_ticker: e.event_ticker, sub_title: e.sub_title
        }))
      };
    } catch (err) {
      debug.results.kalshi = { status: "error", error: err.message };
    }
  }

  debug.results.draftkings = {
    status: "league-page",
    url: DK_LEAGUE_URLS[sportKey] || "N/A",
    note: "Deep links come from Odds API includeLinks on frontend"
  };
  debug.results.fanduel = {
    status: "league-page",
    url: FD_LEAGUE_URLS[sportKey] || "N/A",
    note: "Deep links come from Odds API includeLinks on frontend"
  };

  debug.cacheStats = {
    kalshiEntries: [...resolverCache.keys()].filter(k => k.startsWith("kalshi:")).length,
    totalEntries: resolverCache.size,
    ttl: `${CACHE_TTL / 60000} min`
  };

  res.json(debug);
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "betting-aggregator-v21",
    oddsApiKey: ODDS_API_KEY ? "configured" : "NOT SET",
    architecture: {
      kalshi: "Direct event links via Kalshi public API",
      draftkings: "Sport game lines pages + Odds API deep links (frontend)",
      fanduel: "Sport navigation pages + Odds API deep links (frontend)"
    },
    cache: { entries: resolverCache.size, ttl: `${CACHE_TTL / 60000} min` }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Betting aggregator v21 running on port ${PORT}`);
  console.log(`ODDS_API_KEY: ${ODDS_API_KEY ? "configured ✓" : "NOT SET — add it in Render env vars"}`);
  console.log(`Debug: http://localhost:${PORT}/api/debug?sportKey=basketball_nba`);
});
