'use strict';

// Shared set-up for the DollarBaan Plus tests: a complete profile (cores, Plus modules and routes)
// on a fresh fake IndexedDB database, a fake price feed and canned Tehran Stock Exchange answers.
require('fake-indexeddb/auto');
const crypto = require('crypto');
const { openStore } = require('../public/assets/js/local/idb-store.js');
const { SettingsCore } = require('../public/assets/js/shared/core/settings.js');
const { MarketCore } = require('../public/assets/js/shared/core/market.js');
const { PlusPortfolioCore } = require('../public/assets/js/shared/plus/portfolio.js');
const { createPlus } = require('../public/assets/js/shared/plus/runtime.js');
const { createPlusRoutes } = require('../public/assets/js/shared/plus/routes.js');
const { CASH_SYMBOL } = require('../public/assets/js/shared/catalog.js');
const { tehranDate, addDays } = require('../public/assets/js/shared/dates.js');

const TODAY = tehranDate();
const day = (offset) => addDays(TODAY, offset);

const quote = (symbol, fields) => ({
    symbol, nameEn: symbol, currency: 'IRT', unit: 'unit', high: null, low: null, stale: false,
    time: new Date(), rateSymbol: null, proxy: null, ...fields,
});

class FakeProvider {
    constructor() {
        this.id = 'iran-market';
        this.backfillOnly = false;
        this.historyRefreshMs = 12 * 60 * 60 * 1000;
    }

    async prepare() {}

    async fetchLatest() {
        return {
            publishedAt: new Date().toISOString(),
            quotes: [
                quote('USD_IRR_FREE', { nameFa: 'دلار آمریکا', category: 'currency', price: 100000, prevClose: 98000 }),
                quote('GOLD_18K_IRR', { nameFa: 'طلای ۱۸ عیار', category: 'gold', unit: 'gram', price: 10000000, prevClose: 9900000 }),
                quote('ETH_IRR', { nameFa: 'اتریوم', category: 'crypto', price: 470000000, prevClose: 465000000 }),
                quote('EUR_IRR_FREE', { nameFa: 'یورو', category: 'currency', price: 110000, prevClose: 109000 }),
                quote('AED_IRR_FREE', { nameFa: 'درهم امارات', category: 'currency', price: 27000, prevClose: 26900 }),
            ],
        };
    }

    hasHistory() {
        return false;
    }

    async fetchHistory() {
        return [];
    }

    async test() {
        return { publishedAt: null };
    }
}

// Canned answers of the Tehran Stock Exchange API.
const TSE = {
    search: { instrumentSearch: [
        { insCode: '46348559193224090', lVal30: 'فولاد مباركه اصفهان', lVal18AFC: 'فولاد', flowTitle: 'بازار بورس', cgrValCotTitle: 'بازار اول' },
        { insCode: '999999999', lVal30: 'آتي فولاد-1405/09/18', lVal18AFC: 'فولاد9', flowTitle: 'بازار آتی', cgrValCotTitle: '' },
    ] },
    identity: { instrumentIdentity: { lVal18AFC: 'فولاد', lVal30: 'فولاد مباركه اصفهان', cgrValCotTitle: 'بازار اول (تابلوی اصلی) بورس', sector: { lSecVal: 'فلزات اساسي' }, instrumentID: 'IRO1FOLD0001' } },
    info: { closingPriceInfo: { pDrCotVal: 5000, pClosing: 5010, priceYesterday: 5150, priceMax: 5080, priceMin: 4990, priceFirst: 5000, dEven: Number(TODAY.replace(/-/g, '')), hEven: 122959 } },
    history: { closingPriceDaily: [
        { dEven: Number(day(-1).replace(/-/g, '')), pClosing: 5150, pDrCotVal: 5120, priceFirst: 5190, priceMax: 5250, priceMin: 5120 },
        { dEven: Number(day(-2).replace(/-/g, '')), pClosing: 5270, pDrCotVal: 5150, priceFirst: 5280, priceMax: 5320, priceMin: 5100 },
    ] },
};

// Tests can answer other hosts (Wallex, Binance, ECB...) by setting this; return undefined to pass.
let extraFetch = null;
const setExtraFetch = (handler) => {
    extraFetch = handler;
};

async function fetchJson(url) {
    if (extraFetch) {
        const answer = await extraFetch(url);
        if (answer !== undefined) return { data: answer };
    }
    if (url.includes('GetInstrumentSearch')) return { data: TSE.search };
    if (url.includes('GetInstrumentIdentity')) return { data: TSE.identity };
    if (url.includes('GetClosingPriceInfo')) return { data: TSE.info };
    if (url.includes('GetClosingPriceDailyList')) return { data: TSE.history };
    throw new Error(`unexpected request ${url}`);
}

let counter = 0;

/** A complete profile on a fresh database; prices have been synced once. */
async function profile() {
    counter += 1;
    const store = await openStore(`plus-test-${counter}-${crypto.randomBytes(3).toString('hex')}`);
    const settings = new SettingsCore({
        store,
        providers: ['iran-market'],
        defaults: () => ({ provider: 'iran-market', iranMarket: { mirror: 'github', customUrl: '' }, navasan: { apiKey: '' }, refreshMinutes: 30, displayUnit: 'toman', chartRange: '6m', watchlist: [] }),
    });
    await settings.load();
    const logger = { info() {}, debug() {}, warn() {}, error() {} };
    const platform = { logger, fetchJson, uuid: () => crypto.randomUUID(), randomHex: (n) => crypto.randomBytes(n).toString('hex') };
    const market = new MarketCore({ store, settings, platform, createProvider: () => new FakeProvider() });
    await market.init();
    const portfolio = new PlusPortfolioCore({ store, market, settings, platform, version: 'test' });
    const plus = createPlus({ store, market, settings, portfolio, platform });
    await plus.init();
    await market.sync({ reason: 'manual' });
    market.stop();
    return { store, settings, market, portfolio, plus, routes: createPlusRoutes({ plus, portfolio }) };
}

/** The free-market dollar at 50,000 toman for the last 800 days, as the feed's own history. */
async function seedDollar(p) {
    const rows = [];
    for (let offset = -800; offset <= -1; offset += 1) {
        rows.push({ symbol: 'USD_IRR_FREE', date: day(offset), open: 50000, high: 50000, low: 50000, close: 50000, origin: 'provider' });
    }
    await p.store.upsertPrices(rows);
    p.market.history.delete('USD_IRR_FREE');
}

const buy = (symbol, quantity, unitPrice, date, extra = {}) => ({ symbol, side: 'buy', quantity, unitPrice, date, ...extra });
const deposit = (amount, date, sourceId = 'src_salary', extra = {}) => ({ symbol: CASH_SYMBOL, side: 'buy', quantity: amount, date, sourceId, ...extra });
const holding = async (p, symbol) => (await p.portfolio.getPortfolio()).holdings.find((item) => item.symbol === symbol);

module.exports = { TODAY, day, TSE, profile, seedDollar, buy, deposit, holding, setExtraFetch, CASH_SYMBOL };
