'use strict';

// DollarBaan Plus profiles on the server. The default profile ("main") is the configured database
// and the singleton services, exactly as in upstream DollarBaan. Every other profile has a database
// of its own ("<name>-<id>"), so profiles share nothing. A runtime bundles one profile's cores,
// its API router and its timers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Sequelize } = require('sequelize');
const config = require('../config');
const logger = require('../logger');
const platform = require('../platform');
const { contentDisposition } = require('../lib/http');
const auth = require('./auth');
const { createDatabase } = require('../db');
const defaultStore = require('../store');
const { settings: defaultSettings, defaults } = require('./settings');
const { market: defaultMarket } = require('./market');
const defaultPortfolio = require('./portfolio');
const defaultPlus = require('./plus');
const { isMigrationPending } = require('./legacy');
const { settingsCore, marketCore, providers, plus: plusShared, routes: routesCore } = require('../shared');
const { badRequest, notFound } = require('../lib/errors');

const MAIN = 'main';
const MAX_PROFILES = 50;
const NAME_LIMIT = 40;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const cleanName = (value) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);

const runtimes = new Map();

/* ---------- registry (kept in the default profile's settings) ---------- */

function registry() {
    const saved = defaultSettings.get('profiles');
    const list = saved && Array.isArray(saved.list) ? saved.list.filter((item) => item && ID_PATTERN.test(String(item.id))) : [];
    if (!list.some((item) => item.id === MAIN)) list.unshift({ id: MAIN, name: 'پروفایل من', createdAt: new Date().toISOString() });
    return list;
}

const saveRegistry = (list) => defaultSettings.set('profiles', { list });

function list() {
    return registry().map((item) => ({ id: item.id, name: item.name, createdAt: item.createdAt, main: item.id === MAIN }));
}

function entryOf(id) {
    return registry().find((item) => item.id === id) || null;
}

/* ---------- databases ---------- */

function databaseOptions(id) {
    if (config.db.dialect === 'sqlite') {
        const { dir, name, ext } = path.parse(config.db.storage);
        return { storage: path.join(dir, `${name}-${id}${ext}`) };
    }
    return { name: `${config.db.name}_${id}` };
}

async function dropDatabase(id) {
    const options = databaseOptions(id);
    if (config.db.dialect === 'sqlite') {
        for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(options.storage + suffix, { force: true });
        return;
    }
    const admin = new Sequelize('', config.db.user, config.db.password, { host: config.db.host, port: config.db.port, dialect: 'mysql', logging: false });
    try {
        await admin.query(`DROP DATABASE IF EXISTS \`${options.name.replace(/`/g, '')}\``);
    } finally {
        await admin.close();
    }
}

/* ---------- runtimes ---------- */

function buildRouter(runtime) {
    const router = express.Router();
    for (const route of runtime.routes) {
        router[route.method.toLowerCase()](route.path, async (req, res) => {
            const result = await route.handler({
                params: req.params,
                query: req.query,
                body: req.body,
                session: req.session,
                profile: { id: runtime.id, name: (entryOf(runtime.id) || {}).name },
            });
            if (route.download) {
                res.set('Content-Type', result.type);
                res.set('Content-Disposition', contentDisposition(result.filename));
                return res.send(result.body);
            }
            if (route.status === 204) return res.status(204).end();
            return res.status(route.status || 200).json(result);
        });
    }
    return router;
}

function assemble({ id, store, settings, market, portfolio, plus, close }) {
    const createProvider = (preferences) => providers.createProvider(preferences, platform);
    const runtime = {
        id,
        store,
        settings,
        market,
        portfolio,
        plus,
        started: false,
        routes: [
            ...plusShared.routes.createPlusRoutes({ plus, portfolio }),
            ...routesCore.createRoutes({
                market,
                portfolio,
                settings,
                providers: providers.PROVIDERS,
                createProvider,
                mode: 'server',
                version: config.version,
                account: (ctx) => ({ username: ctx.session.username, defaultPassword: auth.usesDefaultPassword() }),
                statusExtras: () => ({ ...(id === MAIN ? { legacyPending: isMigrationPending() } : {}), ...plus.statusExtras() }),
            }),
        ],
        start() {
            if (runtime.started) return;
            runtime.started = true;
            market.start();
            plus.start();
        },
        stop() {
            runtime.started = false;
            market.stop();
            plus.stop();
        },
        close: close || (async () => {}),
    };
    runtime.router = buildRouter(runtime);
    return runtime;
}

/** The default profile wraps the singleton services (market.init() has already run for them). */
function defaultRuntime() {
    if (!runtimes.has(MAIN)) {
        runtimes.set(MAIN, assemble({
            id: MAIN,
            store: defaultStore,
            settings: defaultSettings,
            market: defaultMarket,
            portfolio: defaultPortfolio,
            plus: defaultPlus,
        }));
    }
    return runtimes.get(MAIN);
}

async function createRuntime(id) {
    const db = createDatabase(databaseOptions(id));
    await db.initDatabase();
    const store = defaultStore.createStore(db);
    const settings = new settingsCore.SettingsCore({ store, defaults });
    await settings.load();
    const market = new marketCore.MarketCore({
        store,
        settings,
        platform,
        createProvider: (preferences) => providers.createProvider(preferences, platform),
    });
    await market.init();
    const portfolio = new plusShared.portfolio.PlusPortfolioCore({ store, market, settings, platform, version: config.version });
    const plus = plusShared.runtime.createPlus({ store, market, settings, portfolio, platform });
    await plus.init();
    return assemble({ id, store, settings, market, portfolio, plus, close: () => db.close() });
}

const pending = new Map();

/** The runtime of a profile, created on first use. */
async function get(id) {
    const entry = entryOf(id || MAIN);
    if (!entry) throw notFound('پروفایل پیدا نشد', 'profile_not_found');
    if (entry.id === MAIN) return defaultRuntime();
    if (runtimes.has(entry.id)) return runtimes.get(entry.id);
    if (!pending.has(entry.id)) {
        pending.set(entry.id, createRuntime(entry.id)
            .then((runtime) => {
                runtimes.set(entry.id, runtime);
                runtime.start();
                return runtime;
            })
            .finally(() => pending.delete(entry.id)));
    }
    return pending.get(entry.id);
}

/** Starts every profile's price updates (called once the server is up). */
async function startAll() {
    defaultRuntime().start();
    for (const entry of registry()) {
        if (entry.id === MAIN) continue;
        try {
            await get(entry.id);
        } catch (error) {
            logger.error(`Cannot start profile ${entry.id}: ${error.message}`);
        }
    }
}

function stopAll() {
    for (const runtime of runtimes.values()) runtime.stop();
}

async function closeAll() {
    for (const [id, runtime] of runtimes) if (id !== MAIN) await runtime.close().catch(() => {});
}

/* ---------- management ---------- */

function uniqueName(name, exceptId = null) {
    const clean = cleanName(name);
    if (!clean) throw badRequest('نام پروفایل را وارد کنید');
    if (registry().some((item) => item.id !== exceptId && item.name.toLowerCase() === clean.toLowerCase())) throw badRequest('پروفایلی با این نام وجود دارد');
    return clean;
}

async function create(name, { id = null } = {}) {
    const items = registry();
    if (items.length >= MAX_PROFILES) throw badRequest('تعداد پروفایل‌ها به سقف مجاز رسیده است');
    const clean = uniqueName(name);
    let newId = id && ID_PATTERN.test(id) && id !== MAIN && !items.some((item) => item.id === id) ? id : `p${crypto.randomBytes(4).toString('hex')}`;
    while (items.some((item) => item.id === newId)) newId = `p${crypto.randomBytes(4).toString('hex')}`;
    items.push({ id: newId, name: clean, createdAt: new Date().toISOString() });
    await saveRegistry(items);
    try {
        await get(newId);
    } catch (error) {
        await saveRegistry(items.filter((item) => item.id !== newId));
        throw error;
    }
    return entryOf(newId);
}

async function rename(id, name) {
    const items = registry();
    const entry = items.find((item) => item.id === id);
    if (!entry) throw notFound('پروفایل پیدا نشد');
    entry.name = uniqueName(name, id);
    await saveRegistry(items);
    return entry;
}

async function remove(id) {
    if (id === MAIN) throw badRequest('پروفایل اصلی سرور حذف نمی‌شود؛ می‌توانید نام آن را تغییر دهید');
    const items = registry();
    if (!items.some((item) => item.id === id)) throw notFound('پروفایل پیدا نشد');
    const runtime = runtimes.get(id);
    if (runtime) {
        runtime.stop();
        await runtime.close().catch(() => {});
        runtimes.delete(id);
    }
    await saveRegistry(items.filter((item) => item.id !== id));
    await dropDatabase(id);
}

async function reorder(ids) {
    const items = registry();
    const order = new Map(ids.map((id, index) => [id, index]));
    items.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e6) - (order.has(b.id) ? order.get(b.id) : 1e6));
    await saveRegistry(items);
}

/* ---------- full backup ---------- */

async function exportFull() {
    const profiles = [];
    for (const entry of registry()) {
        const runtime = await get(entry.id);
        profiles.push({ id: entry.id, name: entry.name, createdAt: entry.createdAt, data: await runtime.portfolio.exportData({ name: entry.name }) });
    }
    return {
        app: plusShared.backup.APP_ID,
        format: plusShared.backup.FORMAT,
        kind: 'full',
        version: config.version,
        exportedAt: new Date().toISOString(),
        activeProfile: MAIN,
        appSettings: {},
        profiles,
    };
}

async function importFull(payload, mode) {
    if (plusShared.backup.backupKind(payload) !== 'plus-full') throw badRequest('این فایل، پشتیبان کامل دلاربان پلاس نیست');
    if (payload.profiles.length > MAX_PROFILES) throw badRequest('تعداد پروفایل‌های فایل بیش از حد مجاز است');
    const replace = mode === 'replace';
    const restored = [];
    for (const item of payload.profiles) {
        if (!item || !item.data) continue;
        let entry = entryOf(item.id);
        if (!entry) {
            try {
                entry = await create(item.name, { id: item.id });
            } catch {
                entry = await create(`${cleanName(item.name)} (بازیابی)`, { id: item.id });
            }
        }
        const runtime = await get(entry.id);
        await runtime.portfolio.importData(item.data, { mode: replace ? 'replace' : 'merge' });
        restored.push(entry.id);
    }
    if (!restored.length) throw badRequest('فایل پشتیبان هیچ پروفایلی ندارد');
    if (replace) {
        for (const entry of registry()) if (!restored.includes(entry.id) && entry.id !== MAIN) await remove(entry.id);
    }
    return { profiles: restored.length, appSettings: payload.appSettings || {} };
}

module.exports = {
    MAIN,
    list,
    entryOf,
    get,
    startAll,
    stopAll,
    closeAll,
    create,
    rename,
    remove,
    reorder,
    exportFull,
    importFull,
};
