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
    kalshiCategories: ["Politics", "Government & Politics"],
    seriesTickers: ["KXPRESPARTY", "KXSENATE", "KXHOUSE", "KXPRESWIN"],
    fallbackUrl: "https://kalshi.com/category/politics",
    searchTerms: ["president", "congress", "senate", "election", "governor", "political", "democrat", "republican", "trump", "biden", "tariff", "impeach", "cabinet", "executive order", "supreme court", "scotus", "legislation", "bill", "veto", "shutdown"]
  },
  elections: {
    label: "Elections",
    kalshiCategories: ["Elections"],
    seriesTickers: ["KXPRESPARTY", "KXPRESWIN", "KXSENATE", "KXHOUSE", "KXGOV"],
    fallbackUrl: "https://kalshi.com/category/elections",
    searchTerms: ["election", "vote", "ballot", "primary", "electoral", "midterm", "2026", "2028", "runoff", "special election", "nominee", "candidate", "caucus", "swing state"]
  },
  crypto: {
    label: "Crypto",
    kalshiCategories: ["Crypto"],
    seriesTickers: ["KXBTC", "KXETH", "KXBTCUSD", "KXETHUSD", "KXBTCD", "KXETHD", "KXSOL", "KXDOGE", "KXADA"],
    fallbackUrl: "https://kalshi.com/category/crypto",
    searchTerms: ["bitcoin", "ethereum", "crypto", "btc", "eth", "solana", "dogecoin", "xrp", "cardano", "blockchain"]
  },
  climate: {
    label: "Climate",
    kalshiCategories: ["Climate", "Weather", "Climate and Weather"],
    seriesTickers: ["KXHIGHNY", "KXHIGHCHI", "KXHIGHLA", "KXHIGHMIA", "KXHURRICANE"],
    fallbackUrl: "https://kalshi.com/category/climate",
    searchTerms: ["temperature", "hurricane", "weather", "climate", "wildfire", "rainfall", "drought", "flood", "storm", "tornado", "snowfall", "heat wave", "cold"]
  },
  economics: {
    label: "Economics",
    kalshiCategories: ["Economics", "Economy", "Financial"],
    seriesTickers: ["KXFED", "KXCPI", "KXGDP", "KXUNRATE", "KXJOBS", "KXINFL", "KXRECESSION"],
    fallbackUrl: "https://kalshi.com/category/economics",
    searchTerms: ["fed", "inflation", "gdp", "unemployment", "recession", "interest rate", "cpi", "jobs", "economic", "fomc", "rate cut", "rate hike", "payroll", "consumer price"]
  },
  financials: {
    label: "Financials",
    kalshiCategories: ["Financials"],
    seriesTickers: ["KXSPY", "KXNAS", "KXDOW", "KXVIX", "KXSPX", "KXNDX", "KXQQQ", "KXIWM"],
    fallbackUrl: "https://kalshi.com/category/financials",
    searchTerms: ["stock", "s&p", "nasdaq", "dow", "market", "index", "equity", "share price", "vix", "treasury", "yield", "bond", "s&p 500", "russell", "oil", "crude", "brent", "wti", "gold", "silver", "agriculture", "wheat", "corn", "eur/usd", "forex", "euro", "dollar"]
  },
  companies: {
    label: "Companies",
    kalshiCategories: ["Companies"],
    seriesTickers: ["KXAAPL", "KXGOOG", "KXMSFT", "KXTSLA", "KXAMZN", "KXNVDA", "KXMETA"],
    fallbackUrl: "https://kalshi.com/category/companies",
    searchTerms: ["apple", "google", "microsoft", "tesla", "amazon", "nvidia", "meta", "earnings", "revenue", "ipo", "stock price", "market cap", "ceo"]
  },
  techscience: {
    label: "Tech & Science",
    kalshiCategories: ["Tech & Science", "Science", "Technology"],
    seriesTickers: ["KXAI", "KXSPACEX", "KXFDA"],
    fallbackUrl: "https://kalshi.com/category/tech-and-science",
    searchTerms: ["ai", "artificial intelligence", "spacex", "nasa", "launch", "fda", "tech", "science", "robotics", "quantum", "regulation", "openai", "chatgpt", "gpt"]
  },
  culture: {
    label: "Culture",
    kalshiCategories: ["Culture", "Entertainment"],
    seriesTickers: ["KXOSCARS", "KXGRAMMYS", "KXEMMYS"],
    fallbackUrl: "https://kalshi.com/category/culture",
    searchTerms: ["oscars", "grammys", "emmys", "awards", "movie", "music", "entertainment", "box office", "streaming", "netflix", "disney", "james bond", "super bowl halftime"]
  },
  mentions: {
    label: "Mentions",
    kalshiCategories: ["Mentions"],
    seriesTickers: ["KXTRUMP", "KXELON", "KXBIDEN"],
    fallbackUrl: "https://kalshi.com/category/mentions",
    searchTerms: ["mention", "tweet", "truth social", "speech", "press conference", "interview", "said", "statement", "x post", "social media"]
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Subcategory mapping system — derives subcategories from series tickers and title keywords
// ─────────────────────────────────────────────────────────────────────────────

const SUBCATEGORY_RULES = {
  politics: [
    { name: "Trump", match: (ev) => /trump|maga|executive order|tariff|cabinet|attorney general|press sec/i.test(ev.title + ' ' + (ev.sub_title || '')) || /KXTRUMP/i.test(ev.series_ticker) },
    { name: "Congress", match: (ev) => /congress|senate|house|speaker|legislation|bill|shutdown|funded|dhs|appropriat/i.test(ev.title + ' ' + (ev.sub_title || '')) || /SENATE|HOUSE|KXNEXTSPEAKER/i.test(ev.series_ticker) },
    { name: "SCOTUS & Courts", match: (ev) => /scotus|supreme court|court|judicial|judge|ruling/i.test(ev.title + ' ' + (ev.sub_title || '')) },
    { name: "International", match: (ev) => /iran|china|russia|ukraine|nato|eu |europe|israel|hormuz|nuclear deal|war|peace/i.test(ev.title + ' ' + (ev.sub_title || '')) },
    { name: "Local", match: (ev) => /governor|mayor|state|local/i.test(ev.title + ' ' + (ev.sub_title || '')) && !/president/i.test(ev.title) },
  ],
  elections: [
    { name: "Presidential", match: (ev) => /president/i.test(ev.title) || /KXPRES/i.test(ev.series_ticker) },
    { name: "Senate", match: (ev) => /senate/i.test(ev.title) || /SENATE/i.test(ev.series_ticker) },
    { name: "House", match: (ev) => /house|representative/i.test(ev.title) || /HOUSE/i.test(ev.series_ticker) },
    { name: "Governor", match: (ev) => /governor/i.test(ev.title) || /GOV/i.test(ev.series_ticker) },
    { name: "International", match: (ev) => /pope|uk |israel|eu |europe|canada|alberta/i.test(ev.title + ' ' + (ev.sub_title || '')) },
  ],
  crypto: [
    { name: "Bitcoin", match: (ev) => /bitcoin|btc/i.test(ev.title) || /KXBTC/i.test(ev.series_ticker) },
    { name: "Ethereum", match: (ev) => /ethereum|eth/i.test(ev.title) || /KXETH/i.test(ev.series_ticker) },
    { name: "Solana", match: (ev) => /solana|sol/i.test(ev.title) || /KXSOL/i.test(ev.series_ticker) },
    { name: "Other Crypto", match: (ev) => /doge|cardano|xrp|ada/i.test(ev.title) || /KXDOGE|KXADA|KXXRP/i.test(ev.series_ticker) },
  ],
  economics: [
    { name: "Fed", match: (ev) => /fed |federal fund|fomc|rate cut|rate hike|fed chair/i.test(ev.title) || /KXFED/i.test(ev.series_ticker) },
    { name: "Inflation & CPI", match: (ev) => /inflation|cpi|consumer price/i.test(ev.title) || /KXCPI|KXINFL/i.test(ev.series_ticker) },
    { name: "GDP", match: (ev) => /gdp/i.test(ev.title) || /KXGDP/i.test(ev.series_ticker) },
    { name: "Jobs", match: (ev) => /unemployment|jobs|payroll|labor/i.test(ev.title) || /KXUNRATE|KXJOBS/i.test(ev.series_ticker) },
    { name: "Recession", match: (ev) => /recession/i.test(ev.title) || /KXRECESSION/i.test(ev.series_ticker) },
  ],
  financials: [
    { name: "Oil & Gas", match: (ev) => /oil|crude|brent|wti|gas price|opec/i.test(ev.title) },
    { name: "S&P", match: (ev) => /s&p|s\&p|spx|spy/i.test(ev.title) || /KXSPY|KXSPX/i.test(ev.series_ticker) },
    { name: "Nasdaq", match: (ev) => /nasdaq|qqq|ndx/i.test(ev.title) || /KXQQQ|KXNAS|KXNDX/i.test(ev.series_ticker) },
    { name: "Treasuries", match: (ev) => /treasury|treasuries|yield|bond/i.test(ev.title) },
    { name: "EUR/USD", match: (ev) => /eur\/usd|euro.*dollar|forex/i.test(ev.title) },
    { name: "Metals", match: (ev) => /gold|silver|platinum|metal/i.test(ev.title) || /KXGLD/i.test(ev.series_ticker) },
    { name: "Agriculture", match: (ev) => /wheat|corn|soybean|agriculture|crop/i.test(ev.title) },
  ],
  climate: [
    { name: "Temperature", match: (ev) => /temperature|high|heat|cold|warm/i.test(ev.title) || /KXHIGH/i.test(ev.series_ticker) },
    { name: "Hurricane", match: (ev) => /hurricane|tropical|storm/i.test(ev.title) || /KXHURRICANE/i.test(ev.series_ticker) },
  ],
  techscience: [
    { name: "AI", match: (ev) => /\bai\b|artificial intelligence|openai|chatgpt|gpt|llm|machine learning/i.test(ev.title) || /KXAI/i.test(ev.series_ticker) },
    { name: "Space", match: (ev) => /spacex|nasa|launch|rocket|mars|moon|satellite/i.test(ev.title) || /KXSPACEX/i.test(ev.series_ticker) },
    { name: "FDA", match: (ev) => /fda|drug|pharma|approv/i.test(ev.title) || /KXFDA/i.test(ev.series_ticker) },
  ],
  culture: [
    { name: "Awards", match: (ev) => /oscar|grammy|emmy|award|golden globe/i.test(ev.title) },
    { name: "Movies & TV", match: (ev) => /movie|film|box office|streaming|netflix|disney|series|show/i.test(ev.title) },
    { name: "Music", match: (ev) => /music|album|song|concert|tour|billboard/i.test(ev.title) },
  ],
  companies: [
    { name: "Tesla", match: (ev) => /tesla/i.test(ev.title) || /KXTSLA/i.test(ev.series_ticker) },
    { name: "Apple", match: (ev) => /apple/i.test(ev.title) || /KXAAPL/i.test(ev.series_ticker) },
    { name: "Google", match: (ev) => /google|alphabet/i.test(ev.title) || /KXGOOG/i.test(ev.series_ticker) },
    { name: "Microsoft", match: (ev) => /microsoft/i.test(ev.title) || /KXMSFT/i.test(ev.series_ticker) },
    { name: "Amazon", match: (ev) => /amazon/i.test(ev.title) || /KXAMZN/i.test(ev.series_ticker) },
    { name: "Nvidia", match: (ev) => /nvidia/i.test(ev.title) || /KXNVDA/i.test(ev.series_ticker) },
    { name: "Meta", match: (ev) => /\bmeta\b|facebook/i.test(ev.title) || /KXMETA/i.test(ev.series_ticker) },
  ],
};

function deriveSubcategory(catKey, ev) {
  const rules = SUBCATEGORY_RULES[catKey];
  if (!rules) return "Other";
  for (const rule of rules) {
    if (rule.match(ev)) return rule.name;
  }
  return "Other";
}

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
  const existingTickers = new Set();

  // Strategy 1: Fetch by known series tickers
  for (const ticker of catConfig.seriesTickers) {
    try {
      const url = `${KALSHI_API_BASE}/events?series_ticker=${ticker}&with_nested_markets=true&status=open&limit=100`;
      const data = await fetchJson(url);
      const events = data?.events || [];
      console.log(`[Kalshi-Cat] ${ticker}: ${events.length} events`);
      for (const ev of events) {
        if (!existingTickers.has(ev.event_ticker)) {
          allEvents.push(ev);
          existingTickers.add(ev.event_ticker);
        }
      }
    } catch (err) {
      console.warn(`[Kalshi-Cat] ${ticker} failed: ${err.message}`);
    }
  }

  // Strategy 2: Paginated broad search — match by Kalshi's category field AND search terms
  // Always run this (not just when <5) to discover events beyond hardcoded tickers
  const terms = catConfig.searchTerms;
  const kalshiCategoryNames = catConfig.kalshiCategories || [catConfig.label];
  let cursor = null;
  let pages = 0;
  const maxPages = 8; // up to 1600 events scanned

  while (pages < maxPages) {
    try {
      let url = `${KALSHI_API_BASE}/events?with_nested_markets=true&status=open&limit=200`;
      if (cursor) url += `&cursor=${cursor}`;
      const data = await fetchJson(url);
      const events = data?.events || [];
      if (events.length === 0) break;

      const filtered = events.filter(ev => {
        // Match by Kalshi's own category field
        const evCat = (ev.category || "").toLowerCase();
        if (kalshiCategoryNames.some(c => evCat === c.toLowerCase())) return true;
        // Match by search terms in title/subtitle/ticker
        const text = [ev.title, ev.sub_title, ev.event_ticker, ev.series_ticker].filter(Boolean).join(" ").toLowerCase();
        return terms.some(term => text.includes(term));
      });
      for (const ev of filtered) {
        if (!existingTickers.has(ev.event_ticker)) {
          allEvents.push(ev);
          existingTickers.add(ev.event_ticker);
        }
      }
      console.log(`[Kalshi-Cat] Broad page ${pages + 1}: ${filtered.length} matching from ${events.length} (total: ${allEvents.length})`);

      cursor = data?.cursor || null;
      if (!cursor) break;
      pages++;
    } catch (err) {
      console.warn(`[Kalshi-Cat] Broad search page ${pages + 1} failed: ${err.message}`);
      break;
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
      subcategory: deriveSubcategory(catKey, ev),
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

  // Build subcategory summary
  const subcategoryCounts = {};
  for (const m of markets) {
    const sub = m.subcategory || "Other";
    if (!subcategoryCounts[sub]) subcategoryCounts[sub] = 0;
    subcategoryCounts[sub]++;
  }
  const subcategories = Object.entries(subcategoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const result = {
    ok: true,
    category: catConfig.label,
    count: markets.length,
    fallbackUrl: catConfig.fallbackUrl,
    subcategories,
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
    service: "betting-aggregator-v23",
    oddsApiKey: ODDS_API_KEY ? "configured" : "NOT SET",
    architecture: {
      kalshi: "Direct event links via Kalshi public API",
      draftkings: "Sport game lines pages + Odds API deep links (frontend)",
      fanduel: "Sport navigation pages + Odds API deep links (frontend)"
    },
    cache: { entries: resolverCache.size, ttl: `${CACHE_TTL / 60000} min` }
  });
});

app.get("/api/cache-clear", (req, res) => {
  const count = resolverCache.size;
  resolverCache.clear();
  res.json({ ok: true, cleared: count });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Betting aggregator v23 running on port ${PORT}`);
  console.log(`ODDS_API_KEY: ${ODDS_API_KEY ? "configured ✓" : "NOT SET — add it in Render env vars"}`);
  console.log(`Debug: http://localhost:${PORT}/api/debug?sportKey=basketball_nba`);
});
