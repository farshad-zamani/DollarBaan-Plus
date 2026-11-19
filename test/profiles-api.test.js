'use strict';

// DollarBaan Plus on the server: profiles (each in its own database), cash, withdrawals, profit and loss
// and backups through the real HTTP API.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dollarbaan-plus-api-'));
Object.assign(process.env, {
    DB_DIALECT: 'sqlite',
    SQLITE_PATH: path.join(tempDir, 'plus.sqlite'),
    LOG_DIR: 'off',
    LOG_LEVEL: 'error',
    AUTH_USERNAME: 'tester',
    AUTH_PASSWORD: 'secret-pass-1',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase, sequelize } = require('../server/db');
const { settings } = require('../server/services/settings');
const { market } = require('../server/services/market');
const plus = require('../server/services/plus');
const runtimes = require('../server/services/runtimes');
const { createApp } = require('../server/app');
const { tehranDate, addDays } = require('../public/assets/js/shared/dates.js');

const TODAY = tehranDate();
const day = (offset) => addDays(TODAY, offset);

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
            quotes: [{
                symbol: 'USD_IRR_FREE', nameFa: 'دلار آمریکا', nameEn: 'USD', category: 'currency', currency: 'IRT', unit: 'unit', price: 100000, prevClose: 98000,
                high: null, low: null, stale: false, time: new Date(), rateSymbol: null, proxy: null,
            }],
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

let server;
let base;
let cookie = '';

async function call(method, url, body, headers = {}) {
    const response = await fetch(base + url, {
        method,
        headers: {
            'X-Requested-With': 'DollarBaan',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = null;
    }
    return { status: response.status, data, text, headers: response.headers };
}

test.before(async () => {
    await initDatabase();
    await settings.load();
    await market.init();
    await plus.init();
    market.provider = new FakeProvider();
    await market.sync({ reason: 'test' });
    server = await new Promise((resolve) => {
        const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await call('POST', '/api/auth/login', { username: 'tester', password: 'secret-pass-1' });
    cookie = login.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
    runtimes.stopAll();
    market.stop();
    plus.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await new Promise((resolve) => server.close(resolve));
    await runtimes.closeAll();
    await sequelize.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the main profile exists and cannot be deleted', async () => {
    const list = await call('GET', '/api/profiles');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.profiles.map((item) => item.id), ['main']);
    assert.equal(list.data.active, 'main');
    assert.equal((await call('DELETE', '/api/profiles/main')).status, 400);
    const boot = await call('GET', '/api/bootstrap');
    assert.equal(boot.data.active, 'main');
    assert.ok(boot.data.categories.includes('cash') && boot.data.categories.includes('stock'));
});

test('profiles are isolated: each has its own assets, transactions, cash and settings', async () => {
    const created = await call('POST', '/api/profiles', { name: ' خانواده ' });
    assert.equal(created.status, 201);
    const id = created.data.created;
    assert.ok(/^p[0-9a-f]{8}$/.test(id));
    assert.equal(created.data.profiles.find((item) => item.id === id).name, 'خانواده');
    assert.equal((await call('POST', '/api/profiles', { name: 'خانواده' })).status, 400);
    assert.ok(fs.readdirSync(tempDir).some((name) => name.includes(id)), 'its own database file exists');

    const asProfile = { 'X-Profile': id };
    const asset = await call('POST', '/api/custom-assets', { name: 'آپارتمان', kind: 'realestate', unit: 'واحد', price: 5e9 }, asProfile);
    assert.equal(asset.status, 201);
    const tx = await call('POST', '/api/transactions', { symbol: asset.data.symbol, side: 'buy', quantity: 1, unitPrice: 4e9, date: day(-10), location: 'سند رسمی' }, asProfile);
    assert.equal(tx.status, 201);
    assert.equal(tx.data.location, 'سند رسمی');

    // The main profile sees none of it.
    assert.equal((await call('GET', '/api/transactions')).data.length, 0);
    assert.equal((await call('GET', '/api/transactions', undefined, asProfile)).data.length, 1);
    assert.ok(!(await call('GET', '/api/assets')).data.some((item) => item.symbol === asset.data.symbol));

    // Settings are per profile too.
    await call('PUT', '/api/settings', { displayUnit: 'rial' }, asProfile);
    assert.equal((await call('GET', '/api/settings')).data.preferences.displayUnit, 'toman');
    assert.equal((await call('GET', '/api/settings', undefined, asProfile)).data.preferences.displayUnit, 'rial');

    // Cash and its sources.
    const deposit = await call('POST', '/api/transactions', { symbol: 'CASH_IRT', side: 'buy', quantity: 1000000, date: day(-5), sourceId: 'src_salary' }, asProfile);
    assert.equal(deposit.status, 201);
    assert.equal((await call('POST', '/api/transactions', { symbol: 'CASH_IRT', side: 'buy', quantity: 1, date: day(-5) }, asProfile)).status, 400);
    const overview = await call('GET', '/api/cash/overview', undefined, asProfile);
    assert.equal(overview.data.balance, 1000000);
    assert.equal(overview.data.bySource[0].name, 'حقوق و درآمد کاری');
    assert.equal((await call('GET', '/api/cash/overview')).data.balance, 0);
    const source = await call('POST', '/api/cash/sources', { name: 'سود اجاره' }, asProfile);
    assert.equal(source.status, 201);
    assert.ok((await call('GET', '/api/cash/sources', undefined, asProfile)).data.some((item) => item.name === 'سود اجاره'));
    assert.ok(!(await call('GET', '/api/cash/sources')).data.some((item) => item.name === 'سود اجاره'));

    // Profit and loss, lots and locations work through the API.
    const pnl = await call('GET', '/api/pnl?mode=all', undefined, asProfile);
    assert.equal(pnl.status, 200);
    assert.equal(pnl.data.byAsset.length, 1);
    assert.equal(pnl.data.summary.unrealized, 5e9 - 4e9);
    const lots = await call('GET', `/api/portfolio/lots?symbol=${asset.data.symbol}`, undefined, asProfile);
    assert.equal(lots.data.lots[0].location, 'سند رسمی');
    assert.equal((await call('GET', '/api/locations', undefined, asProfile)).data[0].name, 'سند رسمی');
    assert.equal((await call('GET', '/api/pnl')).data.empty, true);

    // An unknown profile is a clear error.
    assert.equal((await call('GET', '/api/transactions', undefined, { 'X-Profile': 'nope' })).status, 404);
});

test('profile and full backups, with Persian file names', async () => {
    const [, second] = (await call('GET', '/api/profiles')).data.profiles;
    const asProfile = { 'X-Profile': second.id };

    const file = await call('GET', `/api/export?profile=${second.id}`);
    assert.equal(file.status, 200);
    assert.equal(file.data.app, 'DollarBaanPlus');
    assert.equal(file.data.profile.name, 'خانواده');
    assert.equal(file.data.transactions.length, 2);
    assert.equal(file.data.cash.sources.custom[0].name, 'سود اجاره');
    assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''dollarbaanplus-backup-/);
    assert.ok(file.data.transactions.some((tx) => tx.location === 'سند رسمی'));

    // The original DollarBaan's export format restores into the main profile.
    const original = {
        app: 'DollarBaan',
        format: 1,
        preferences: { watchlist: ['USD_IRR_FREE'], displayUnit: 'toman', chartRange: '3m' },
        customAssets: [],
        transactions: [{ symbol: 'USD_IRR_FREE', side: 'buy', quantity: 10, unitPrice: 90000, fee: 0, date: day(-8), note: 'از نسخه اصلی' }],
    };
    const imported = await call('POST', '/api/import', original);
    assert.equal(imported.status, 200);
    assert.equal((await call('GET', '/api/transactions')).data.length, 1);

    const full = await call('GET', '/api/backup/full');
    assert.equal(full.status, 200);
    assert.equal(full.data.kind, 'full');
    assert.equal(full.data.profiles.length, 2);
    assert.match(full.headers.get('content-disposition'), /dollarbaanplus-full-backup/);

    // Restoring it again merges without duplicates.
    const restored = await call('POST', '/api/backup/full', full.data);
    assert.equal(restored.status, 200);
    assert.equal(restored.data.profiles, 2);
    assert.equal((await call('GET', '/api/transactions')).data.length, 1);
    assert.equal((await call('GET', '/api/transactions', undefined, asProfile)).data.length, 2);

    // A profile backup cannot be used where a full one is expected, and the other way round.
    assert.equal((await call('POST', '/api/backup/full', file.data)).status, 400);
    assert.equal((await call('POST', '/api/import', full.data)).status, 400);
});

test('a backup can fill a brand new profile, and failed ones leave nothing behind', async () => {
    const second = (await call('GET', '/api/profiles')).data.profiles[1];
    const file = (await call('GET', `/api/export?profile=${second.id}`)).data;
    const created = await call('POST', '/api/profiles', { name: 'کپی', payload: file });
    assert.equal(created.status, 201);
    const copy = { 'X-Profile': created.data.created };
    assert.equal((await call('GET', '/api/transactions', undefined, copy)).data.length, 2);
    assert.ok((await call('GET', '/api/assets', undefined, copy)).data.some((asset) => asset.name === 'آپارتمان'));

    const before = (await call('GET', '/api/profiles')).data.profiles.length;
    const bad = await call('POST', '/api/profiles', { name: 'خراب', payload: { app: 'DollarBaan', transactions: [{ symbol: 'CUSTOM_AAAAAAAAAA', side: 'buy', quantity: 1, unitPrice: 1, date: TODAY }] } });
    assert.equal(bad.status, 400);
    assert.equal((await call('GET', '/api/profiles')).data.profiles.length, before);
});

test('renaming, ordering and deleting profiles', async () => {
    const [, second, third] = (await call('GET', '/api/profiles')).data.profiles;
    assert.equal((await call('PUT', `/api/profiles/${second.id}`, { name: 'خانوادهٔ من' })).status, 200);
    assert.equal((await call('PUT', `/api/profiles/${third.id}`, { name: 'خانوادهٔ من' })).status, 400);
    const order = await call('PUT', '/api/profiles-order', { ids: ['main', third.id, second.id] });
    assert.deepEqual(order.data.profiles.map((item) => item.id), ['main', third.id, second.id]);

    for (const profile of [second, third]) {
        assert.equal((await call('DELETE', `/api/profiles/${profile.id}`)).status, 200);
        assert.equal((await call('GET', '/api/transactions', undefined, { 'X-Profile': profile.id })).status, 404);
    }
    assert.deepEqual((await call('GET', '/api/profiles')).data.profiles.map((item) => item.id), ['main']);
    assert.ok(!fs.readdirSync(tempDir).some((name) => name.includes(second.id)), 'its database file is gone');
});
