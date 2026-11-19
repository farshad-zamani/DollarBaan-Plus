// The in-app backend: the same data API as the Node server, running on the device.
// Data lives in IndexedDB; prices come straight from Iran Market (CORS-enabled JSON).
//
// DollarBaan Plus: every profile has its own database and its own set of cores; the profile that is
// open answers the API. Profile management and full backups are app-level routes handled here.
import { SettingsCore } from '../shared/core/settings.js';
import { MarketCore } from '../shared/core/market.js';
import { createRoutes } from '../shared/core/routes.js';
import { createProvider, PROVIDERS } from '../shared/providers/index.js';
import { DEFAULT_WATCHLIST } from '../shared/catalog.js';
import { AppError, HttpError, notFound, badRequest } from '../shared/errors.js';
import { openStore } from './idb-store.js';
import { VERSION } from '../version.js';
import { PlusPortfolioCore } from '../shared/plus/portfolio.js';
import { createPlus } from '../shared/plus/runtime.js';
import { createPlusRoutes } from '../shared/plus/routes.js';
import { exportProfile, backupKind, APP_ID, FORMAT } from '../shared/plus/backup.js';
import { tehranDate } from '../shared/dates.js';
import * as registry from './profiles.js';

const LOCAL_PROVIDERS = PROVIDERS.filter((provider) => provider.id === 'iran-market');
const REQUEST_TIMEOUT_MS = 60000;

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** The browser revalidates with ETags itself (cache: 'no-cache'), so no ETag bookkeeping here. */
async function fetchJson(url) {
    let response;
    try {
        const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
        response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache', signal });
    } catch {
        throw new HttpError(`Request to ${hostOf(url)} failed`, { url });
    }
    if (!response.ok) throw new HttpError(`Request to ${hostOf(url)} failed with HTTP ${response.status}`, { status: response.status, url });
    try {
        return { data: await response.json(), etag: null };
    } catch {
        throw new HttpError(`Invalid JSON from ${hostOf(url)}`, { url });
    }
}

function randomHex(bytes) {
    const values = crypto.getRandomValues(new Uint8Array(bytes));
    return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const hex = randomHex(16).split('');
    hex[12] = '4';
    hex[16] = '89ab'[parseInt(hex[16], 16) & 3];
    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const platform = {
    logger: {
        info: () => {},
        debug: () => {},
        warn: (message) => console.warn(`[DollarBaan Plus] ${message}`),
        error: (message) => console.error(`[DollarBaan Plus] ${message}`),
    },
    fetchJson,
    uuid,
    randomHex,
};

const defaults = () => ({
    provider: 'iran-market',
    iranMarket: { mirror: 'github', customUrl: '' },
    navasan: { apiKey: '' },
    refreshMinutes: 30,
    displayUnit: 'toman',
    chartRange: '6m',
    watchlist: [...DEFAULT_WATCHLIST],
});

function compile(routes) {
    return routes.map((route) => {
        const names = [];
        const pattern = route.path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (match, name) => {
            names.push(name);
            return '([^/]+)';
        });
        return { ...route, regex: new RegExp(`^${pattern}$`), names };
    });
}

/** Everything one profile needs: its own database, cores and routes. */
async function startProfile(entry) {
    const store = await openStore(registry.databaseName(entry.id));
    const settings = new SettingsCore({ store, defaults, providers: LOCAL_PROVIDERS.map((provider) => provider.id) });
    await settings.load();
    const makeProvider = (preferences) => createProvider(preferences, platform);
    const market = new MarketCore({ store, settings, platform, createProvider: makeProvider });
    await market.init();
    const portfolio = new PlusPortfolioCore({ store, market, settings, platform, version: VERSION });
    const plus = createPlus({ store, market, settings, portfolio, platform });
    await plus.init();

    const runtime = {
        id: entry.id,
        store,
        settings,
        market,
        portfolio,
        plus,
        started: false,
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
        syncIfStale() {
            if (market.isStale() && !market.syncing) market.sync({ reason: 'resume' });
        },
    };
    runtime.routes = compile([
        ...createPlusRoutes({ plus, portfolio }),
        ...createRoutes({
            market,
            portfolio,
            settings,
            providers: LOCAL_PROVIDERS,
            createProvider: makeProvider,
            mode: 'local',
            version: VERSION,
            account: () => ({ username: null, defaultPassword: false }),
            statusExtras: () => plus.statusExtras(),
        }),
        {
            // Local-only: wipe this profile's data (Settings › Data on this device).
            method: 'POST',
            path: '/local/reset',
            handler: async () => {
                runtime.stop();
                await store.clearAll();
                await plus.cash.ensureAsset();
                return { ok: true };
            },
        },
    ]);
    return runtime;
}

// One runtime per profile, created on first use. Only the open profile keeps its timers running.
const runtimes = new Map();

function runtimeFor(id) {
    if (!runtimes.has(id)) {
        if (!registry.find(id)) return Promise.reject(notFound('پروفایل پیدا نشد'));
        const pending = startProfile(registry.find(id));
        runtimes.set(id, pending);
        pending.catch(() => runtimes.delete(id));
    }
    return runtimes.get(id);
}

function startApp() {
    const syncIfStale = async () => {
        const runtime = await runtimeFor(registry.activeId());
        runtime.syncIfStale();
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncIfStale();
    });
    window.addEventListener('online', syncIfStale);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    return runtimeFor(registry.activeId()).then((runtime) => {
        runtime.start();
        return runtime;
    });
}

/* ---------- profiles and full backups (app level, not part of any profile) ---------- */

function describeProfiles() {
    return { profiles: registry.list(), active: registry.activeId() };
}

function checked(result) {
    if (result && result.error) throw badRequest(result.error);
    return result;
}

async function switchTo(id) {
    if (!registry.find(id)) throw notFound('پروفایل پیدا نشد');
    if (registry.activeId() !== id) {
        const previous = await runtimeFor(registry.activeId());
        previous.stop();
        registry.activate(id);
    }
    const next = await runtimeFor(id);
    next.start();
    return next;
}

async function removeProfile(id) {
    const wasActive = registry.activeId() === id;
    const runtime = runtimes.has(id) ? await runtimes.get(id).catch(() => null) : null;
    checked(registry.remove(id));
    runtimes.delete(id);
    if (runtime) {
        runtime.stop();
        runtime.store.close();
    }
    await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(registry.databaseName(id));
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
    });
    if (wasActive) await switchTo(registry.activeId());
}

async function exportFull() {
    const profiles = [];
    for (const entry of registry.list()) {
        const runtime = await runtimeFor(entry.id);
        profiles.push({
            id: entry.id,
            name: entry.name,
            createdAt: entry.createdAt,
            data: await exportProfile(runtime.portfolio, { name: entry.name }),
        });
    }
    let theme = null;
    try {
        theme = localStorage.getItem('dollarbaan.theme');
    } catch {
        theme = null;
    }
    return {
        app: APP_ID,
        format: FORMAT,
        kind: 'full',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        activeProfile: registry.activeId(),
        appSettings: { theme },
        profiles,
    };
}

async function importFull(payload, mode) {
    if (backupKind(payload) !== 'plus-full') throw badRequest('این فایل، پشتیبان کامل دلاربان پلاس نیست');
    if (payload.profiles.length > 50) throw badRequest('تعداد پروفایل‌های فایل بیش از حد مجاز است');
    const replace = mode === 'replace';
    const restored = [];
    for (const item of payload.profiles) {
        if (!item || !item.data) continue;
        let entry = registry.find(item.id);
        if (!entry) {
            let added = registry.add(item.name, { id: item.id });
            // A name clash: keep both profiles, the restored one gets a suffix.
            if (added.error) added = registry.add(`${registry.cleanProfileName(item.name)} (بازیابی)`, { id: item.id });
            entry = checked(added).profile;
        }
        const runtime = await runtimeFor(entry.id);
        await runtime.portfolio.importData(item.data, { mode: replace ? 'replace' : 'merge' });
        restored.push(entry.id);
    }
    if (!restored.length) throw badRequest('فایل پشتیبان هیچ پروفایلی ندارد');
    if (replace) {
        for (const entry of registry.list()) if (!restored.includes(entry.id)) await removeProfile(entry.id);
    }
    await switchTo(restored.includes(payload.activeProfile) ? payload.activeProfile : restored[0]);
    return { profiles: restored.length, appSettings: payload.appSettings || {} };
}

const appRoutes = compile([
    { method: 'GET', path: '/profiles', handler: () => describeProfiles() },
    {
        method: 'POST',
        path: '/profiles',
        status: 201,
        // Creates a profile, optionally filled from a backup file; the new profile opens when it is ready.
        handler: async ({ body = {} }) => {
            const { profile } = checked(registry.add(body.name));
            try {
                const runtime = await runtimeFor(profile.id);
                if (body.payload) await runtime.portfolio.importData(body.payload, { mode: 'replace' });
            } catch (error) {
                await removeProfile(profile.id).catch(() => {});
                throw error;
            }
            if (body.open !== false) await switchTo(profile.id);
            return { ...describeProfiles(), created: profile.id };
        },
    },
    {
        method: 'PUT',
        path: '/profiles/:id',
        handler: ({ params, body = {} }) => {
            checked(registry.rename(params.id, body.name));
            return describeProfiles();
        },
    },
    {
        method: 'DELETE',
        path: '/profiles/:id',
        handler: async ({ params }) => {
            await removeProfile(params.id);
            return describeProfiles();
        },
    },
    {
        method: 'POST',
        path: '/profiles/:id/activate',
        handler: async ({ params }) => {
            await switchTo(params.id);
            return describeProfiles();
        },
    },
    {
        method: 'PUT',
        path: '/profiles-order',
        handler: ({ body = {} }) => {
            registry.reorder(Array.isArray(body.ids) ? body.ids.map(String) : []);
            return describeProfiles();
        },
    },
    {
        method: 'GET',
        path: '/backup/full',
        download: true,
        handler: async () => ({
            filename: `dollarbaanplus-full-backup-${tehranDate()}.json`,
            type: 'application/json; charset=utf-8',
            body: JSON.stringify(await exportFull(), null, 2),
        }),
    },
    { method: 'POST', path: '/backup/full', handler: ({ query, body }) => importFull(body, query.mode === 'replace' ? 'replace' : 'merge') },
]);

async function dispatch(routes, method, path, context) {
    for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.regex.exec(path);
        if (!match) continue;
        const params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
        const result = await route.handler({ ...context, params });
        if (route.download) return { done: true, result };
        return { done: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
    }
    return { done: false };
}

let backend = null;

/** Handles an API call ("/api/...") locally. Resolves with plain JSON data like the server. */
export async function handle(method, url, body) {
    if (!backend) backend = startApp();
    await backend;
    const parsed = new URL(url, 'http://local');
    const path = parsed.pathname.replace(/^\/api/, '');
    const query = Object.fromEntries(parsed.searchParams);

    const app = await dispatch(appRoutes, method, path, { query, body, session: null });
    if (app.done) return app.result;

    // Every other call belongs to a profile: the open one, or the one named by ?profile=.
    const entry = registry.find(query.profile) || registry.find(registry.activeId());
    const runtime = await runtimeFor(entry.id);
    const profile = { id: entry.id, name: entry.name };
    const outcome = await dispatch(runtime.routes, method, path, { query, body, session: null, profile });
    if (!outcome.done) throw notFound('مسیر پیدا نشد', 'not_found');
    if (path === '/bootstrap' && outcome.result) return { ...outcome.result, ...describeProfiles(), profile };
    return outcome.result;
}

export { AppError };
