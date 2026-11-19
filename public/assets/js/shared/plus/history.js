// Deep price history for DollarBaan Plus.
//
// The price feed publishes long daily history for only some assets. Cryptocurrencies quoted in toman
// start a few weeks back, and most currencies have none, so older purchases had no market price to
// suggest and charts started late. This engine fills the missing past on demand, from the first date
// a user needs back to the earliest price already stored, and never overwrites existing prices:
//
//   crypto         Wallex (toman, exact)  ->  Binance USDT pair x free-market dollar  ->  feed's USD series x dollar
//   foreign money  fixed pegs (AED, SAR, ...) or ECB cross rates (Frankfurter)  x  free-market dollar
//
// Prices derived through the dollar are estimates; the segments are remembered so screens can say so.
import { tehranDate, addDays } from '../dates.js';
import { closeAsOf } from '../ledger.js';

const WALLEX_URL = 'https://api.wallex.ir/v1/udf/history';
const BINANCE_URL = 'https://api.binance.com/api/v3/klines';
const ECB_URL = 'https://api.frankfurter.dev/v1';
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const SLACK_DAYS = 7;
const USD_SYMBOL = 'USD_IRR_FREE';
const STATE_KEY = 'historyBackfill';

// Currencies fixed to the dollar: US dollars in one unit.
export const PEGS = {
    AED: 1 / 3.6725,
    SAR: 1 / 3.75,
    QAR: 1 / 3.64,
    OMR: 1 / 0.3845,
    BHD: 1 / 0.376,
    JOD: 1 / 0.709,
};

/** What kind of asset this is for history purposes: { kind, code } or null when nothing can be added. */
export function classify(asset) {
    if (!asset || asset.source !== 'market') return null;
    const crypto = /^([A-Z0-9]{2,10})_IRR$/.exec(asset.symbol);
    if (asset.category === 'crypto' && crypto) return { kind: 'crypto', code: crypto[1] };
    const money = /^([A-Z]{3})_IRR_FREE$/.exec(asset.symbol);
    if (asset.category === 'currency' && money && money[1] !== 'USD') return { kind: 'currency', code: money[1] };
    return null;
}

const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/** TradingView-style candles { s, t[], o[], h[], l[], c[] } to daily rows. */
export function parseUdf(payload) {
    if (!payload || payload.s !== 'ok' || !Array.isArray(payload.t) || !Array.isArray(payload.c)) return [];
    const rows = [];
    for (let i = 0; i < payload.t.length; i += 1) {
        const close = num(payload.c[i]);
        const date = tehranDate(new Date(Number(payload.t[i]) * 1000));
        if (!close || !date) continue;
        rows.push({ date, open: num(payload.o && payload.o[i]) || close, high: num(payload.h && payload.h[i]) || close, low: num(payload.l && payload.l[i]) || close, close });
    }
    return rows;
}

/** Binance klines [[openTime, open, high, low, close, ...]] to daily rows (UTC days). */
export function parseKlines(payload) {
    if (!Array.isArray(payload)) return [];
    const rows = [];
    for (const item of payload) {
        const close = num(item && item[4]);
        if (!close) continue;
        rows.push({ date: new Date(Number(item[0])).toISOString().slice(0, 10), open: num(item[1]) || close, high: num(item[2]) || close, low: num(item[3]) || close, close });
    }
    return rows;
}

/** Frankfurter time series { rates: { date: { CODE: unitsPerDollar } } } to [{ date, perDollar }]. */
export function parseEcb(payload, code) {
    const rates = payload && payload.rates && typeof payload.rates === 'object' ? payload.rates : {};
    return Object.entries(rates)
        .map(([date, values]) => ({ date, perDollar: num(values && values[code]) }))
        .filter((row) => row.perDollar)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Multiplies rows quoted in dollars by the free-market dollar rate of each day. */
export function viaDollar(rows, usd) {
    const out = [];
    for (const row of rows) {
        const rate = closeAsOf(usd, row.date);
        if (!rate) continue;
        const k = rate.close;
        out.push({ date: row.date, open: row.open * k, high: row.high * k, low: row.low * k, close: row.close * k });
    }
    return out;
}

export class HistoryEngine {
    /**
     * @param {object} options
     * @param {object} options.store     storage adapter
     * @param {object} options.market    MarketCore (the engine registers itself as market.extensions.history)
     * @param {object} options.settings  SettingsCore
     * @param {object} options.platform  { logger, fetchJson }
     */
    constructor({ store, market, settings, platform }) {
        this.store = store;
        this.market = market;
        this.settings = settings;
        this.logger = platform.logger;
        this.fetchJson = platform.fetchJson;
        this.inflight = new Map();
        market.extensions.history = this;
    }

    state() {
        const saved = this.settings.get(STATE_KEY);
        return saved && typeof saved === 'object' ? saved : {};
    }

    /** { source, estimated } when the price of `date` came from this engine. */
    describe(symbol, date) {
        const entry = this.state()[symbol];
        const segment = entry && Array.isArray(entry.segments) ? entry.segments.find((item) => date >= item.from && date <= item.to) : null;
        return segment ? { source: segment.source, estimated: segment.estimated } : null;
    }

    async usdSeries() {
        if (!this.market.getAsset(USD_SYMBOL)) return [];
        await this.market.ensureHistory(USD_SYMBOL);
        return this.market.historyRows(USD_SYMBOL);
    }

    /* ---------- sources ---------- */

    async getJson(url) {
        return (await this.fetchJson(url)).data;
    }

    async wallex(code, from, to) {
        const rows = [];
        // Windows of about two years keep every answer small.
        for (let start = from; start <= to; start = addDays(start, 731)) {
            const end = addDays(start, 730) < to ? addDays(start, 730) : to;
            const query = `symbol=${code}TMN&resolution=D&from=${Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000)}&to=${Math.floor(Date.parse(`${end}T23:59:59Z`) / 1000)}`;
            rows.push(...parseUdf(await this.getJson(`${WALLEX_URL}?${query}`)));
        }
        return rows;
    }

    async binance(code, from, to) {
        const rows = [];
        let start = Date.parse(`${from}T00:00:00Z`);
        const end = Date.parse(`${to}T23:59:59Z`);
        while (start < end) {
            const batch = parseKlines(await this.getJson(`${BINANCE_URL}?symbol=${code}USDT&interval=1d&startTime=${start}&endTime=${end}&limit=1000`));
            if (!batch.length) break;
            rows.push(...batch);
            const next = Date.parse(`${batch[batch.length - 1].date}T00:00:00Z`) + 86400000;
            if (batch.length < 1000 || next <= start) break;
            start = next;
        }
        return rows;
    }

    async ecb(code, from, to) {
        return parseEcb(await this.getJson(`${ECB_URL}/${from}..${to}?base=USD&symbols=${code}`), code);
    }

    /** Ordered sources for an asset: exact ones first. Each returns daily rows in toman, oldest first. */
    sourcesFor(plan) {
        const dollar = async (rows) => viaDollar(rows, await this.usdSeries());
        if (plan.kind === 'crypto') {
            const list = [];
            if (plan.code !== 'USDT' && plan.code !== 'USDC') {
                list.push({ id: 'wallex', estimated: false, fetch: (from, to) => this.wallex(plan.code, from, to) });
                list.push({ id: 'binance', estimated: true, fetch: async (from, to) => dollar(await this.binance(plan.code, from, to)) });
                list.push({
                    id: 'feed-usd',
                    estimated: true,
                    fetch: async (from, to) => {
                        const symbol = `${plan.code}_USD`;
                        if (!this.market.getAsset(symbol)) return [];
                        await this.market.ensureHistory(symbol);
                        const rows = (await this.market.historyRows(symbol)).filter((row) => row.date >= from && row.date <= to);
                        return dollar(rows.map((row) => ({ date: row.date, open: row.close, high: row.close, low: row.close, close: row.close })));
                    },
                });
            } else {
                list.push({ id: 'wallex', estimated: false, fetch: (from, to) => this.wallex(plan.code, from, to) });
                // A dollar stablecoin trades close to the free-market dollar.
                list.push({
                    id: 'dollar-peg',
                    estimated: true,
                    fetch: async (from, to) => (await this.usdSeries()).filter((row) => row.date >= from && row.date <= to)
                        .map((row) => ({ date: row.date, open: row.close, high: row.close, low: row.close, close: row.close })),
                });
            }
            return list;
        }
        if (PEGS[plan.code]) {
            return [{
                id: 'peg',
                estimated: true,
                fetch: async (from, to) => (await this.usdSeries()).filter((row) => row.date >= from && row.date <= to)
                    .map((row) => ({ date: row.date, open: row.close * PEGS[plan.code], high: row.close * PEGS[plan.code], low: row.close * PEGS[plan.code], close: row.close * PEGS[plan.code] })),
            }];
        }
        return [{
            id: 'ecb',
            estimated: true,
            fetch: async (from, to) => {
                const rates = await this.ecb(plan.code, from, to);
                const usd = await this.usdSeries();
                return rates.map((rate) => {
                    const point = closeAsOf(usd, rate.date);
                    if (!point) return null;
                    const close = point.close / rate.perDollar;
                    return { date: rate.date, open: close, high: close, low: close, close };
                }).filter(Boolean);
            },
        }];
    }

    /* ---------- coverage ---------- */

    /**
     * Makes sure prices exist back to `date` (a week of slack included). Safe to call often: an asset
     * is only looked at again after a day, and nothing is fetched when it is already covered.
     */
    async ensureCoverage(symbol, date) {
        const asset = this.market.getAsset(symbol);
        const plan = classify(asset);
        if (!plan || !date || date >= tehranDate()) return;
        const key = `history:${symbol}`;
        if (!this.inflight.has(key)) {
            this.inflight.set(key, this.fill(symbol, plan, date)
                .catch((error) => this.logger.warn(`Deep history of ${symbol} failed: ${error.message}`))
                .finally(() => this.inflight.delete(key)));
        }
        return this.inflight.get(key);
    }

    async fill(symbol, plan, date) {
        const want = addDays(date, -SLACK_DAYS);
        const entry = this.state()[symbol] || null;
        if (entry && entry.tried <= want && Date.now() - Date.parse(entry.at) < RETRY_AFTER_MS) return;

        await this.market.ensureHistory(symbol);
        const existing = await this.market.seriesFor(symbol);
        let cursor = existing.length ? existing[0].date : tehranDate();
        if (cursor <= date) return;

        const segments = entry && Array.isArray(entry.segments) ? [...entry.segments] : [];
        for (const source of this.sourcesFor(plan)) {
            if (cursor <= want) break;
            let rows = [];
            try {
                rows = await source.fetch(want, addDays(cursor, -1));
            } catch (error) {
                this.logger.warn(`${source.id} history of ${symbol}: ${error.message}`);
            }
            rows = rows.filter((row) => row.date < cursor && row.date >= want).sort((a, b) => (a.date < b.date ? -1 : 1));
            if (!rows.length) continue;
            await this.store.upsertPrices(rows.map((row) => ({ symbol, ...row, origin: 'backfill' })));
            segments.push({ source: source.id, estimated: source.estimated, from: rows[0].date, to: rows[rows.length - 1].date });
            cursor = rows[0].date;
        }
        this.market.history.delete(symbol);
        await this.settings.set(STATE_KEY, { ...this.state(), [symbol]: { at: new Date().toISOString(), tried: want, covered: cursor, segments } });
    }

    /** After a transaction is recorded: reach back to a month before the asset's first purchase. */
    async trackNow(symbols) {
        for (const symbol of symbols) {
            if (!classify(this.market.getAsset(symbol))) continue;
            const first = await this.firstDateOf(symbol);
            if (first) await this.ensureCoverage(symbol, addDays(first, -31));
        }
    }

    async firstDateOf(symbol) {
        const rows = await this.store.transactionsFor([symbol]);
        return rows.reduce((min, row) => (!min || row.date < min ? row.date : min), null);
    }

    /** Every held asset, for the app start. */
    async backfillHeld() {
        await this.trackNow(await this.store.heldSymbols());
    }
}
