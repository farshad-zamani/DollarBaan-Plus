'use strict';

// Deep price history: crypto and currency prices for dates the price feed does not cover.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TODAY, day, profile, seedDollar, buy, setExtraFetch } = require('../test-support/plus-harness.js');
const history = require('../public/assets/js/shared/plus/history.js');

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY_MS = 86400000;

/** Binance answer: a constant daily price of 1000 dollars. */
function klines(url) {
    const start = Number(/startTime=(\d+)/.exec(url)[1]);
    const end = Number(/endTime=(\d+)/.exec(url)[1]);
    const out = [];
    for (let ms = start; ms <= end && out.length < 1000; ms += DAY_MS) out.push([ms, '1000', '1000', '1000', '1000']);
    return out;
}

test('parsers and the dollar conversion', () => {
    assert.equal(history.classify({ symbol: 'ETH_IRR', source: 'market', category: 'crypto' }).code, 'ETH');
    assert.equal(history.classify({ symbol: 'EUR_IRR_FREE', source: 'market', category: 'currency' }).kind, 'currency');
    assert.equal(history.classify({ symbol: 'USD_IRR_FREE', source: 'market', category: 'currency' }), null);
    assert.equal(history.classify({ symbol: 'GOLD_18K_IRR', source: 'market', category: 'gold' }), null);
    assert.equal(history.classify({ symbol: 'STK_1', source: 'stock', category: 'stock' }), null);

    assert.deepEqual(history.parseUdf({ s: 'ok', t: [1609459200], o: [1], h: [3], l: [0.5], c: [2] }), [{ date: '2021-01-01', open: 1, high: 3, low: 0.5, close: 2 }]);
    assert.deepEqual(history.parseUdf({ s: 'no_data' }), []);
    assert.equal(history.parseKlines([[1609459200000, '1', '3', '0.5', '2']])[0].date, '2021-01-01');
    assert.deepEqual(history.parseEcb({ rates: { '2020-01-03': { EUR: 0.9 }, '2020-01-02': { EUR: 0.8 } } }, 'EUR').map((row) => row.date), ['2020-01-02', '2020-01-03']);

    const out = history.viaDollar(
        [{ date: '2020-01-05', open: 1, high: 2, low: 1, close: 2 }, { date: '2019-01-01', open: 1, high: 1, low: 1, close: 1 }],
        [{ date: '2020-01-01', close: 100 }]
    );
    assert.deepEqual(out, [{ date: '2020-01-05', open: 100, high: 200, low: 100, close: 200 }]);
});

test('crypto falls back from Wallex to Binance and older prices are marked as estimates', async () => {
    const p = await profile();
    await seedDollar(p);
    const calls = { wallex: 0, binance: 0 };
    setExtraFetch(async (url) => {
        if (url.includes('wallex.ir')) {
            calls.wallex += 1;
            // Wallex lists the pair only from 200 days ago.
            const from = Number(/from=(\d+)/.exec(url)[1]);
            const rows = { s: 'ok', t: [], o: [], h: [], l: [], c: [] };
            for (let offset = -200; offset <= -100; offset += 1) {
                const ts = Date.parse(`${day(offset)}T00:00:00Z`) / 1000;
                if (ts < from) continue;
                rows.t.push(ts);
                rows.o.push(2e7);
                rows.h.push(2e7);
                rows.l.push(2e7);
                rows.c.push(2e7);
            }
            return rows.t.length ? rows : { s: 'no_data' };
        }
        if (url.includes('binance.com')) {
            calls.binance += 1;
            return klines(url);
        }
        return undefined;
    });
    try {
        // Inside Wallex's range: the exact toman price.
        const exact = await p.market.priceAt('ETH_IRR', day(-150));
        assert.equal(exact.price, 2e7);
        assert.equal(exact.estimated, false);
        assert.equal(exact.source, 'wallex');

        // Older than Wallex: Binance's dollar price times the free-market dollar (1000 x 50,000).
        const older = await p.market.priceAt('ETH_IRR', day(-300));
        assert.equal(older.price, 5e7);
        assert.equal(older.estimated, true);
        assert.equal(older.source, 'binance');

        // Asking again does not touch the network.
        const before = { ...calls };
        await p.market.priceAt('ETH_IRR', day(-300));
        assert.deepEqual(calls, before);

        // Existing prices are never overwritten.
        assert.equal((await p.market.priceAt('ETH_IRR', TODAY)).price, 470000000);
    } finally {
        setExtraFetch(null);
    }
});

test('pegged and ECB currencies are derived from the dollar', async () => {
    const p = await profile();
    await seedDollar(p);
    setExtraFetch(async (url) => {
        if (!url.includes('frankfurter.dev')) return undefined;
        const [, start, end] = /(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(url);
        const rates = {};
        for (let ms = Date.parse(start); ms <= Date.parse(end); ms += DAY_MS) rates[iso(ms)] = { EUR: 0.5 };
        return { base: 'USD', rates };
    });
    try {
        const euro = await p.market.priceAt('EUR_IRR_FREE', day(-100));
        assert.equal(euro.price, 100000);            // 50,000 / 0.5
        assert.equal(euro.estimated, true);
        assert.equal(euro.source, 'ecb');

        const dirham = await p.market.priceAt('AED_IRR_FREE', day(-100));
        assert.ok(Math.abs(dirham.price - 50000 / 3.6725) < 1e-6);
        assert.equal(dirham.source, 'peg');

        // Gold has no external history: the answer stays "unknown" instead of inventing a price.
        assert.equal((await p.market.priceAt('GOLD_18K_IRR', day(-500))).price, null);
    } finally {
        setExtraFetch(null);
    }
});

test('a failing source is skipped and the next one is tried', async () => {
    const p = await profile();
    await seedDollar(p);
    setExtraFetch(async (url) => {
        if (url.includes('wallex.ir')) throw new Error('blocked');
        if (url.includes('binance.com')) return klines(url);
        return undefined;
    });
    try {
        const price = await p.market.priceAt('ETH_IRR', day(-40));
        assert.equal(price.price, 5e7);
        assert.equal(price.source, 'binance');
    } finally {
        setExtraFetch(null);
    }
});

test('recording a purchase fills the past up to a month before it', async () => {
    const p = await profile();
    await seedDollar(p);
    setExtraFetch(async (url) => {
        if (url.includes('wallex.ir')) return { s: 'no_data' };
        if (url.includes('binance.com')) return klines(url);
        return undefined;
    });
    try {
        await p.portfolio.createTransaction(buy('ETH_IRR', 1, 4e7, day(-90)));
        await p.market.trackNow(['ETH_IRR']);
        const series = await p.market.seriesFor('ETH_IRR');
        assert.ok(series[0].date <= day(-121), series[0].date);
        assert.ok(series.every((point) => point.close > 0));
    } finally {
        setExtraFetch(null);
    }
});
