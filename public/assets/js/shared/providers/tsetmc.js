// Tehran Stock Exchange (TSETMC) public API, used by DollarBaan Plus for stock and fund prices.
// Shared by the Node server and the in-app (local) backend. The API publishes prices in rials
// and spells Persian with Arabic letters; everything leaving this module is toman and Persian.
import { tehranDate } from '../dates.js';

export const TSETMC_BASE = 'https://cdn.tsetmc.com/api';

const INS_CODE = /^\d{4,24}$/;

export const isInsCode = (value) => INS_CODE.test(String(value));

/** Arabic yeh/kaf and friends to the Persian letters people type and expect to read. */
export function persianText(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/ۀ/g, 'ه')
        .replace(/[‎‏]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

const toToman = (rial) => (rial > 0 ? rial / 10 : null);

/** 20261118 -> "2026-11-18" (the API publishes Gregorian dates as numbers). */
export function isoFromDEven(value) {
    const text = String(Math.trunc(Number(value) || 0));
    if (!/^\d{8}$/.test(text)) return null;
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

/** 122959 -> "12:29:59" */
function timeFromHEven(value) {
    const text = String(Math.trunc(Number(value) || 0)).padStart(6, '0');
    return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`;
}

// Derivatives cannot be held like shares: futures (آتی), options (اختیار) and their series.
const DERIVATIVE = /^(آتی|اختیار)/;

/** Search results: instruments worth adding to a portfolio. */
export function normalizeSearch(payload) {
    const list = payload && Array.isArray(payload.instrumentSearch) ? payload.instrumentSearch : [];
    const out = [];
    for (const item of list) {
        const insCode = String(item && item.insCode);
        if (!isInsCode(insCode)) continue;
        const name = persianText(item.lVal30);
        const ticker = persianText(item.lVal18AFC);
        if (!ticker || !name || DERIVATIVE.test(name)) continue;
        out.push({
            insCode,
            ticker,
            name,
            market: persianText(item.flowTitle) || null,
            board: persianText(item.cgrValCotTitle) || null,
        });
    }
    return out;
}

/** Details of one instrument (ticker, full name, market and sector). */
export function normalizeIdentity(payload, insCode) {
    const identity = payload && payload.instrumentIdentity;
    if (!identity) throw new Error('Unexpected TSETMC identity format');
    const ticker = persianText(identity.lVal18AFC);
    const name = persianText(identity.lVal30);
    if (!ticker || !name) throw new Error('Unexpected TSETMC identity format');
    return {
        insCode: String(insCode),
        ticker,
        name,
        market: persianText(identity.cgrValCotTitle) || null,
        sector: identity.sector ? persianText(identity.sector.lSecVal) || null : null,
        isin: identity.instrumentID || null,
    };
}

/**
 * Latest price of an instrument. The last trade is the live price; if nothing traded yet the
 * closing price, then yesterday's price, stand in so a holding never counts as zero.
 */
export function normalizeInfo(payload, now = Date.now()) {
    const info = payload && payload.closingPriceInfo;
    if (!info) throw new Error('Unexpected TSETMC price format');
    const last = num(info.pDrCotVal);
    const closing = num(info.pClosing);
    const yesterday = num(info.priceYesterday);
    const rial = last > 0 ? last : (closing > 0 ? closing : yesterday);
    if (!(rial > 0)) throw new Error('TSETMC returned no price');

    const date = isoFromDEven(info.dEven);
    const time = date ? new Date(`${date}T${timeFromHEven(info.hEven)}+03:30`) : null;
    const validTime = time && !Number.isNaN(time.getTime()) ? time : null;
    return {
        price: toToman(rial),
        closing: toToman(closing),
        prevClose: toToman(yesterday),
        high: toToman(num(info.priceMax)),
        low: toToman(num(info.priceMin)),
        open: toToman(num(info.priceFirst)),
        time: validTime,
        date,
        stale: !validTime || now - validTime.getTime() > 10 * 24 * 60 * 60 * 1000,
    };
}

/** Daily candles in toman, oldest first. */
export function normalizeHistory(payload) {
    const rows = payload && Array.isArray(payload.closingPriceDaily) ? payload.closingPriceDaily : [];
    const byDate = new Map();
    for (const row of rows) {
        const date = isoFromDEven(row.dEven);
        if (!date) continue;
        const closeRial = num(row.pClosing) > 0 ? num(row.pClosing) : num(row.pDrCotVal);
        const close = toToman(closeRial);
        if (!(close > 0)) continue;
        byDate.set(date, {
            date,
            open: toToman(num(row.priceFirst)) || close,
            high: toToman(num(row.priceMax)) || close,
            low: toToman(num(row.priceMin)) || close,
            close,
        });
    }
    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export class TsetmcClient {
    /** @param {{ fetchJson: Function, logger?: object, base?: string }} options */
    constructor({ fetchJson, logger = console, base = TSETMC_BASE }) {
        this.fetchJson = fetchJson;
        this.logger = logger;
        this.base = base;
    }

    async get(path) {
        const { data } = await this.fetchJson(`${this.base}${path}`);
        return data;
    }

    async search(query) {
        const text = persianText(query);
        if (text.length < 2) return [];
        return normalizeSearch(await this.get(`/Instrument/GetInstrumentSearch/${encodeURIComponent(text)}`));
    }

    async identity(insCode) {
        if (!isInsCode(insCode)) throw new Error('Invalid instrument code');
        return normalizeIdentity(await this.get(`/Instrument/GetInstrumentIdentity/${insCode}`), insCode);
    }

    async info(insCode) {
        if (!isInsCode(insCode)) throw new Error('Invalid instrument code');
        return normalizeInfo(await this.get(`/ClosingPrice/GetClosingPriceInfo/${insCode}`));
    }

    async history(insCode) {
        if (!isInsCode(insCode)) throw new Error('Invalid instrument code');
        return normalizeHistory(await this.get(`/ClosingPrice/GetClosingPriceDailyList/${insCode}/0`));
    }

    async test() {
        // A well-known, always-listed instrument.
        const info = await this.info('46348559193224090');
        return { publishedAt: info.time ? info.time.toISOString() : null, date: info.date || tehranDate() };
    }
}
