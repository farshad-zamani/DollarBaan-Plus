'use strict';

// DollarBaan Plus features on the shared cores: cash, withdrawals, locations, stocks, profit and
// loss and backups, using the IndexedDB adapter (fake-indexeddb) and a fake price provider.
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TODAY, day, TSE, profile, buy, deposit, holding, CASH_SYMBOL } = require('../test-support/plus-harness.js');
const tsetmc = require('../public/assets/js/shared/providers/tsetmc.js');

test('the built-in cash asset is priced at one toman and listed', async () => {
    const p = await profile();
    const cash = p.market.getAsset(CASH_SYMBOL);
    assert.equal(cash.source, 'system');
    assert.equal(p.market.toman(cash).price, 1);
    assert.ok(p.market.catalog().some((asset) => asset.symbol === CASH_SYMBOL));
    assert.equal((await p.market.priceAt(CASH_SYMBOL, day(-30))).price, 1);
});

test('cash deposits need a source and cannot be overspent', async () => {
    const p = await profile();
    await assert.rejects(p.portfolio.createTransaction({ symbol: CASH_SYMBOL, side: 'buy', quantity: 1000, date: day(-5) }), /منبع/);
    await assert.rejects(p.portfolio.createTransaction(deposit(1000, day(-5), 'nope')), /منبع/);
    await p.portfolio.createTransaction(deposit(1000000, day(-5)));
    await assert.rejects(p.portfolio.createTransaction({ symbol: CASH_SYMBOL, side: 'sell', quantity: 2000000, date: day(-1) }), (error) => error.code === 'insufficient_cash');
    await p.portfolio.createTransaction({ symbol: CASH_SYMBOL, side: 'sell', quantity: 400000, date: day(-1), note: 'خرج' });
    const overview = await p.plus.cash.overview();
    assert.equal(overview.balance, 600000);
    assert.equal(overview.totals.in, 1000000);
    assert.equal(overview.totals.out, 400000);
    assert.equal(overview.history.length, 2);
    // The portfolio counts cash as value but never as invested capital.
    const portfolio = await p.portfolio.getPortfolio();
    assert.equal(portfolio.totals.value, 600000);
    assert.equal(portfolio.totals.cash, 600000);
    assert.equal(portfolio.totals.invested, 0);
    assert.equal(portfolio.totals.pnl, 0);
});

test('a purchase can be paid from cash and stays linked when edited or deleted', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(deposit(100000000, day(-30)));
    const usd = await p.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-20), { fee: 1000, cash: { link: true, location: 'کیف پول' } }));
    assert.equal((await p.plus.cash.overview()).balance, 100000000 - 9001000);

    // Too little cash: nothing is written.
    await assert.rejects(p.portfolio.createTransaction(buy('USD_IRR_FREE', 5000, 90000, day(-19), { cash: { link: true } })), (error) => error.code === 'insufficient_cash');
    assert.equal((await p.portfolio.listTransactions()).length, 3);   // deposit, purchase and its cash entry

    await p.portfolio.updateTransaction(usd.id, { ...buy('USD_IRR_FREE', 200, 90000, day(-20)), fee: 1000 });
    assert.equal((await p.plus.cash.overview()).balance, 100000000 - 18001000);
    const linked = (await p.portfolio.allTransactions()).filter((tx) => tx.linkId === usd.id);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].quantity, 18001000);
    assert.equal(linked[0].location, 'کیف پول');

    // Unlinking leaves the cash alone; the purchase is no longer tied to it.
    await p.portfolio.updateTransaction(usd.id, { ...buy('USD_IRR_FREE', 200, 90000, day(-20)), fee: 1000, cash: { link: false } });
    assert.equal((await p.plus.cash.overview()).balance, 100000000);

    await p.portfolio.updateTransaction(usd.id, { ...buy('USD_IRR_FREE', 200, 90000, day(-20)), cash: { link: true } });
    await p.portfolio.deleteTransaction(usd.id);
    assert.equal((await p.plus.cash.overview()).balance, 100000000);
    assert.equal((await p.portfolio.allTransactions()).length, 1);
});

test('a sale pays its proceeds into cash from the "asset sale" source', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-20)));
    await p.portfolio.createTransaction({ symbol: 'USD_IRR_FREE', side: 'sell', quantity: 50, unitPrice: 110000, fee: 500, date: day(-5), cash: { link: true } });
    const overview = await p.plus.cash.overview();
    assert.equal(overview.balance, 50 * 110000 - 500);
    assert.equal(overview.bySource[0].sourceId, 'src_asset_sale');
    assert.match(overview.history[0].reason, /فروش/);
});

test('own deposit sources can be created, renamed, hidden and deleted', async () => {
    const p = await profile();
    const mine = await p.plus.cash.createSource({ name: ' سود شرکت ' });
    assert.equal(mine.name, 'سود شرکت');
    await assert.rejects(p.plus.cash.createSource({ name: 'سود شرکت' }), /قبلاً/);
    await p.portfolio.createTransaction(deposit(5000, day(-3), mine.id));
    await assert.rejects(p.plus.cash.deleteSource(mine.id), /مخفی/);
    await p.plus.cash.updateSource(mine.id, { name: 'سود سهام', archived: true });
    assert.ok(!p.plus.cash.sources().some((item) => item.id === mine.id));
    assert.equal((await p.plus.cash.overview()).bySource[0].name, 'سود سهام');
    await p.plus.cash.updateSource('src_other', { name: 'متفرقه' });
    assert.equal(p.plus.cash.sourceName('src_other'), 'متفرقه');
    await assert.rejects(p.plus.cash.updateSource('src_asset_sale', { archived: true }), /خودکار/);
    await assert.rejects(p.plus.cash.deleteSource('src_other'), /آماده/);
    // A source nothing was deposited from can be deleted.
    const spare = await p.plus.cash.createSource({ name: 'اضافه' });
    await p.plus.cash.deleteSource(spare.id);
});

test('storage locations: per-location holdings, lots and rename', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 10, 80000, day(-40), { location: 'صرافی' }));
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 5, 90000, day(-30), { location: 'گاوصندوق' }));
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 2, 95000, day(-20)));
    await p.portfolio.createTransaction({ symbol: 'USD_IRR_FREE', side: 'sell', quantity: 4, unitPrice: 99000, date: day(-10), location: 'صرافی' });

    const detail = await p.portfolio.getAssetDetail('USD_IRR_FREE');
    const byName = Object.fromEntries(detail.locations.map((row) => [row.location, row.quantity]));
    assert.deepEqual(byName, { صرافی: 6, گاوصندوق: 5, '': 2 });
    assert.equal(detail.locations.reduce((sum, row) => sum + row.share, 0).toFixed(6), '100.000000');

    // FIFO: the four sold units come out of the oldest purchase first.
    const buys = detail.lots.filter((lot) => lot.side === 'buy');
    assert.deepEqual(buys.map((lot) => lot.remaining).reverse(), [6, 5, 2]);
    assert.equal(detail.lots.length, 4);

    const held = await holding(p, 'USD_IRR_FREE');
    assert.deepEqual(held.locations.map((row) => row.location).sort(), ['', 'صرافی', 'گاوصندوق']);

    const names = await p.plus.locations.list();
    assert.deepEqual(names.map((item) => item.name).sort(), ['صرافی', 'گاوصندوق'].sort());
    await p.plus.locations.rename('صرافی', 'صرافی ملی');
    assert.ok((await p.portfolio.allTransactions()).some((tx) => tx.location === 'صرافی ملی'));
    assert.ok(!(await p.portfolio.allTransactions()).some((tx) => tx.location === 'صرافی'));
});

test('profit withdrawals take profit only and can go to cash or leave the app', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-20)));
    await p.portfolio.createTransaction(buy('GOLD_18K_IRR', 2, 9000000, day(-20)));

    const preview = await p.plus.withdrawals.preview({});
    const usd = preview.assets.find((item) => item.symbol === 'USD_IRR_FREE');
    assert.equal(usd.profit, 100 * 100000 - 100 * 90000);

    // More than the profit is refused.
    await assert.rejects(p.plus.withdrawals.create({ destination: 'cash', allocations: [{ type: 'asset', symbol: 'USD_IRR_FREE', amount: usd.profit + 1 }] }), (error) => error.code === 'exceeds_profit');

    const withdrawal = await p.plus.withdrawals.create({ destination: 'cash', cashLocation: 'بانک', allocations: [{ type: 'asset', symbol: 'USD_IRR_FREE', amount: 400000 }] });
    assert.equal(withdrawal.amount, 400000);
    let held = await holding(p, 'USD_IRR_FREE');
    assert.equal(held.quantity, 96);                 // 4 units left
    assert.equal(held.cost, 9000000);                // the cost basis stays
    assert.equal(held.unrealized, 96 * 100000 - 9000000);
    assert.equal(held.withdrawn, 400000);
    assert.equal((await p.plus.cash.overview()).balance, 400000);
    assert.equal((await p.plus.cash.overview()).bySource[0].sourceId, 'src_profit_withdrawal');

    // Profit counts once: what was withdrawn plus what is still open equals the original profit.
    const portfolio = await p.portfolio.getPortfolio();
    const pnl = await p.plus.pnl.compute({});
    assert.equal(pnl.summary.totalProfit, portfolio.totals.pnl);
    assert.equal(pnl.summary.withdrawnAssets, 400000);

    // A mixed withdrawal from an asset and from cash that leaves the app.
    const mixed = await p.plus.withdrawals.create({ destination: 'external', allocations: [{ type: 'asset', symbol: 'GOLD_18K_IRR', amount: 500000 }, { type: 'cash', amount: 100000 }] });
    assert.equal(mixed.allocations.length, 2);
    assert.equal((await p.plus.cash.overview()).balance, 300000);
    await assert.rejects(p.plus.withdrawals.create({ destination: 'cash', allocations: [{ type: 'cash', amount: 1 }] }), /پول نقد/);

    // Rows that belong to a withdrawal cannot be edited or deleted one by one.
    const row = (await p.portfolio.allTransactions()).find((tx) => tx.withdrawalId === withdrawal.id);
    await assert.rejects(p.portfolio.deleteTransaction(row.id), /برداشت سود/);
    await assert.rejects(p.portfolio.updateTransaction(row.id, buy('USD_IRR_FREE', 1, 1, day(-1))), /برداشت سود/);

    const all = await p.plus.pnl.compute({});
    assert.equal(all.withdrawals.totals.count, 2);
    assert.equal(all.withdrawals.totals.fromCash, 100000);
    assert.equal(all.summary.withdrawnTotal, 400000 + 500000 + 100000);
    assert.equal(all.summary.remainingProfit, all.summary.unrealized + all.summary.realized - 100000);

    // Deleting a withdrawal puts everything back.
    await p.plus.withdrawals.remove(mixed.id);
    await p.plus.withdrawals.remove(withdrawal.id);
    held = await holding(p, 'USD_IRR_FREE');
    assert.equal(held.quantity, 100);
    assert.equal((await p.plus.cash.overview()).balance, 0);
    assert.equal((await p.plus.withdrawals.list()).items.length, 0);
});

test('automatic split divides a withdrawal in proportion to each profit', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-20)));        // profit 1,000,000
    await p.portfolio.createTransaction(buy('GOLD_18K_IRR', 2, 9000000, day(-20)));        // profit 2,000,000
    const result = await p.plus.withdrawals.create({ destination: 'external', amount: 900000, symbols: ['USD_IRR_FREE', 'GOLD_18K_IRR'] });
    const parts = Object.fromEntries(result.allocations.map((part) => [part.symbol, part.amount]));
    assert.equal(parts.USD_IRR_FREE, 300000);
    assert.equal(parts.GOLD_18K_IRR, 600000);
    await assert.rejects(p.plus.withdrawals.create({ destination: 'external', amount: 9e9, symbols: ['USD_IRR_FREE'] }), /بیشتر/);
});

test('profit and loss: since purchase and over a period, with filters', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-60), { location: 'الف' }));
    await p.portfolio.createTransaction(buy('GOLD_18K_IRR', 2, 9500000, day(-30), { location: 'ب' }));
    await p.portfolio.createTransaction({ symbol: 'USD_IRR_FREE', side: 'sell', quantity: 20, unitPrice: 95000, date: day(-10), location: 'الف' });

    const all = await p.plus.pnl.compute({});
    assert.equal(all.empty, false);
    assert.equal(all.byAsset.length, 2);
    assert.equal(all.summary.realized, 20 * 95000 - 20 * 90000);
    const usd = all.byAsset.find((row) => row.symbol === 'USD_IRR_FREE');
    assert.equal(usd.quantity, 80);
    assert.equal(usd.unrealized, 80 * 100000 - 80 * 90000);
    assert.equal(all.summary.totalProfit, all.summary.unrealized + all.summary.realized);
    assert.equal(all.timeline[0].profit, 0);
    assert.equal(all.timeline.at(-1).profit.toFixed(2), all.summary.totalProfit.toFixed(2));
    assert.equal(all.realized.items.length, 1);
    assert.equal(all.realized.items[0].realized, 100000);

    const goldOnly = await p.plus.pnl.compute({ symbols: 'GOLD_18K_IRR' });
    assert.deepEqual(goldOnly.byAsset.map((row) => row.symbol), ['GOLD_18K_IRR']);
    assert.equal(goldOnly.summary.realized, 0);
    const location = await p.plus.pnl.compute({ locations: 'ب' });
    assert.deepEqual(location.byAsset.map((row) => row.symbol), ['GOLD_18K_IRR']);
    const category = await p.plus.pnl.compute({ categories: 'currency' });
    assert.deepEqual(category.byAsset.map((row) => row.symbol), ['USD_IRR_FREE']);
    assert.equal(all.byLocation.length, 2);
    assert.ok(all.options.locations.some((item) => item.name === 'الف'));

    // Period mode: nothing was bought or sold in the last 5 days, so the change is value minus value.
    const period = await p.plus.pnl.compute({ mode: 'period', from: day(-5) });
    for (const row of period.byAsset) {
        assert.ok(Math.abs(row.period.pnl - (row.period.endValue - row.period.startValue)) < 1e-6);
        assert.equal(row.period.inflow, 0);
    }
    assert.equal(period.period.pnl.toFixed(4), period.byAsset.reduce((sum, row) => sum + row.period.pnl, 0).toFixed(4));
    assert.ok(period.timeline.length >= 2);

    // Purchases inside the period are money moved, not gain.
    const wide = await p.plus.pnl.compute({ mode: 'period', from: day(-45) });
    const goldRow = wide.byAsset.find((row) => row.symbol === 'GOLD_18K_IRR');
    assert.equal(goldRow.period.inflow, 2 * 9500000);
    assert.equal(goldRow.period.startValue, 0);
    assert.equal(goldRow.period.pnl, 2 * 10000000 - 2 * 9500000);

    await assert.rejects(p.plus.pnl.compute({ mode: 'period' }), /شروع/);
    await assert.rejects(p.plus.pnl.compute({ mode: 'period', from: day(1) }), /شروع/);
    assert.equal((await p.plus.pnl.compute({ symbols: 'NOPE' })).empty, true);
});

test('cash never dilutes the profit percentage', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(deposit(50000000, day(-30)));
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-20), { cash: { link: true } }));
    const portfolio = await p.portfolio.getPortfolio();
    assert.equal(portfolio.totals.invested, 9000000);
    assert.equal(portfolio.totals.value, 50000000 - 9000000 + 100 * 100000);
    assert.equal(portfolio.totals.pnl, 1000000);
    assert.equal(portfolio.totals.pnlPct.toFixed(4), (1000000 / 9000000 * 100).toFixed(4));
    const timeline = await p.portfolio.getTimeline('1y');
    assert.equal(timeline.performance.pct.toFixed(4), (1000000 / 9000000 * 100).toFixed(4));
});

test('Tehran stocks: search, track, price in toman and history', async () => {
    const results = tsetmc.normalizeSearch(TSE.search);
    assert.equal(results.length, 1);                       // futures are not holdable shares
    assert.equal(results[0].name, 'فولاد مبارکه اصفهان');  // Arabic letters become Persian
    const info = tsetmc.normalizeInfo(TSE.info);
    assert.equal(info.price, 500);                         // 5000 rials = 500 toman
    assert.equal(info.prevClose, 515);
    assert.equal(info.date, TODAY);
    assert.deepEqual(tsetmc.normalizeHistory(TSE.history).map((row) => row.close), [527, 515]);
    assert.throws(() => tsetmc.normalizeInfo({ closingPriceInfo: { pDrCotVal: 0, pClosing: 0, priceYesterday: 0 } }), /no price/);

    const p = await profile();
    const found = await p.plus.stocks.search('فولاد');
    assert.equal(found[0].symbol, 'STK_46348559193224090');
    assert.equal(found[0].tracked, false);
    const view = await p.plus.stocks.track('46348559193224090');
    assert.equal(view.category, 'stock');
    assert.equal(view.price, 500);
    assert.equal(view.name, 'فولاد');
    assert.ok(p.market.catalog().some((asset) => asset.symbol === view.symbol));
    await assert.rejects(p.plus.stocks.track('abc'), /معتبر/);

    await p.portfolio.createTransaction(buy(view.symbol, 1000, 480, day(-3)));
    await p.plus.stocks.ensureHistory(view.symbol);
    const series = await p.market.seriesFor(view.symbol);
    assert.ok(series.some((point) => point.close === 527));
    const held = await holding(p, view.symbol);
    assert.equal(held.value, 500000);
    assert.equal(held.unrealized, 20000);
    assert.equal((await p.market.priceAt(view.symbol, day(-2))).price, 527);

    await assert.rejects(p.plus.stocks.untrack(view.symbol), /تراکنش/);
    assert.equal((await p.plus.stocks.sync({ reason: 'manual' })).ok, true);
    p.plus.stocks.stop();
});

test('backups restore everything of a profile, and files from the original DollarBaan', async () => {
    const source = await profile();
    await source.portfolio.createTransaction(deposit(20000000, day(-30), (await source.plus.cash.createSource({ name: 'منبع من' })).id));
    await source.portfolio.createTransaction(buy('USD_IRR_FREE', 100, 90000, day(-20), { location: 'صرافی', cash: { link: true } }));
    await source.plus.stocks.track('46348559193224090');
    await source.portfolio.createTransaction(buy('STK_46348559193224090', 10, 480, day(-3)));
    const custom = await source.market.createCustomAsset({ name: 'آپارتمان', kind: 'realestate', unit: 'واحد', price: 5e9 });
    await source.portfolio.createTransaction(buy(custom.symbol, 1, 4.5e9, day(-10)));
    await source.plus.locations.add('بانک ملت');
    await source.plus.withdrawals.create({ destination: 'cash', allocations: [{ type: 'asset', symbol: 'USD_IRR_FREE', amount: 300000 }] });
    await source.settings.updatePreferences({ displayUnit: 'rial', chartRange: '1y' });

    const file = JSON.parse(JSON.stringify(await source.portfolio.exportData({ name: 'آزمون' })));
    assert.equal(file.app, 'DollarBaanPlus');
    assert.equal(file.format, 2);
    assert.equal(file.profile.name, 'آزمون');
    assert.equal(file.stocks.length, 1);
    assert.equal(file.withdrawals.length, 1);

    const target = await profile();
    const result = await target.portfolio.importData(file, { mode: 'replace' });
    assert.equal(result.transactions, file.transactions.length);
    assert.equal(result.withdrawals, 1);
    assert.equal(result.stocks, 1);
    const before = await source.portfolio.getPortfolio();
    const after = await target.portfolio.getPortfolio();
    assert.equal(after.totals.value.toFixed(2), before.totals.value.toFixed(2));
    assert.equal(after.totals.pnl.toFixed(2), before.totals.pnl.toFixed(2));
    assert.equal((await target.plus.cash.overview()).balance, (await source.plus.cash.overview()).balance);
    assert.ok(target.plus.cash.sources().some((item) => item.name === 'منبع من'));
    assert.deepEqual((await target.plus.locations.list()).map((item) => item.name).sort(), ['بانک ملت', 'صرافی']);
    assert.equal(target.settings.preferences().displayUnit, 'rial');
    assert.equal((await target.plus.withdrawals.list()).items.length, 1);
    assert.ok(target.market.getAsset('STK_46348559193224090'));
    const rows = await target.portfolio.allTransactions();
    assert.equal(rows.find((tx) => tx.kind === 'withdrawal').kind, 'withdrawal');
    assert.ok(rows.some((tx) => tx.linkId));

    // Importing again in merge mode changes nothing.
    await target.portfolio.importData(file, { mode: 'merge' });
    assert.equal((await target.portfolio.allTransactions()).length, rows.length);
    assert.equal((await target.plus.withdrawals.list()).items.length, 1);

    // A file exported by the original DollarBaan (format 1) restores into any profile.
    const original = {
        app: 'DollarBaan',
        format: 1,
        version: '2.1.0',
        preferences: { watchlist: ['USD_IRR_FREE'], displayUnit: 'toman', chartRange: '3m' },
        customAssets: [{ symbol: 'CUSTOM_AABBCCDDEE', name: 'ملک', unit: 'واحد', kind: 'realestate', price: 1e9, history: [{ date: day(-20), close: 9e8 }] }],
        transactions: [
            { id: crypto.randomUUID(), symbol: 'USD_IRR_FREE', side: 'buy', quantity: 5, unitPrice: 80000, fee: 0, date: day(-9), note: 'قدیمی' },
            { id: crypto.randomUUID(), symbol: 'CUSTOM_AABBCCDDEE', side: 'buy', quantity: 1, unitPrice: 9e8, fee: 0, date: day(-9), note: '' },
        ],
    };
    const fresh = await profile();
    const imported = await fresh.portfolio.importData(original, { mode: 'merge' });
    assert.equal(imported.transactions, 2);
    const portfolio = await fresh.portfolio.getPortfolio();
    assert.equal(portfolio.holdings.length, 2);
    assert.equal(fresh.settings.preferences().chartRange, '3m');
    assert.equal((await fresh.portfolio.allTransactions())[0].location, '');

    await assert.rejects(fresh.portfolio.importData({ app: 'Other', transactions: [] }), /معتبر/);
    await assert.rejects(fresh.portfolio.importData({ app: 'DollarBaanPlus', kind: 'full', profiles: [], transactions: [] }), /کامل/);
    await assert.rejects(fresh.portfolio.importData({ app: 'DollarBaan', transactions: [{ symbol: 'NOT_A_SYMBOL', side: 'buy', quantity: 1, unitPrice: 1, date: TODAY }] }), /پیدا نشدند/);
});

test('the Plus API routes are registered once each and expose the new features', async () => {
    const p = await profile();
    const keys = p.routes.map((route) => `${route.method} ${route.path}`);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of ['GET /pnl', 'GET /cash/overview', 'POST /withdrawals', 'GET /stocks/search', 'GET /portfolio/lots', 'GET /export']) {
        assert.ok(keys.includes(key), key);
    }
    const exportRoute = p.routes.find((route) => route.path === '/export');
    const file = await exportRoute.handler({ profile: { id: 'x', name: 'پروفایل من' } });
    assert.match(file.filename, /^dollarbaanplus-backup-.*\.json$/);
    assert.equal(JSON.parse(file.body).profile.name, 'پروفایل من');
});

test('money or units taken out without a location come out of the named places', async () => {
    const p = await profile();
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 10, 80000, day(-40), { location: 'صرافی' }));
    await p.portfolio.createTransaction(buy('USD_IRR_FREE', 4, 85000, day(-35), { location: 'گاوصندوق' }));
    await p.portfolio.createTransaction({ symbol: 'USD_IRR_FREE', side: 'sell', quantity: 6, unitPrice: 99000, date: day(-10) });   // no place named

    const detail = await p.portfolio.getAssetDetail('USD_IRR_FREE');
    const places = Object.fromEntries(detail.locations.map((row) => [row.location, row.quantity]));
    assert.deepEqual(places, { صرافی: 4, گاوصندوق: 4 });                      // 6 units left the largest place first
    assert.equal(detail.locations.reduce((sum, row) => sum + row.quantity, 0), detail.holding.quantity);

    await p.portfolio.createTransaction(deposit(1000000, day(-30), 'src_salary', { location: 'بانک ملت' }));
    await p.portfolio.createTransaction(deposit(500000, day(-29), 'src_salary', { location: 'کیف پول' }));
    await p.portfolio.createTransaction({ symbol: CASH_SYMBOL, side: 'sell', quantity: 1200000, date: day(-5) });          // no place named
    const overview = await p.plus.cash.overview();
    assert.equal(overview.balance, 300000);
    assert.ok(overview.locations.every((item) => item.amount >= 0));
    assert.equal(overview.locations.reduce((sum, item) => sum + item.amount, 0), 300000);
});
