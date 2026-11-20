// Backup files of DollarBaan Plus.
//
//   profile backup  { app: 'DollarBaanPlus', format: 2, kind: 'profile', ... }  everything of one profile
//   full backup     { app: 'DollarBaanPlus', format: 2, kind: 'full', profiles: [...] }  built by the profile manager
//   original files  { app: 'DollarBaan', format: 1, ... }  exported by DollarBaan; they restore into any profile
import { isIsoDate } from '../dates.js';
import { badRequest } from '../errors.js';
import { CUSTOM_KINDS, CASH_SYMBOL } from '../catalog.js';

export const APP_ID = 'DollarBaanPlus';
export const ORIGINAL_APP_ID = 'DollarBaan';
export const FORMAT = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOM_SYMBOL = /^CUSTOM_[A-F0-9]{10}$/;
const MAX_TRANSACTIONS = 100000;

/** What kind of file this is: 'plus-profile', 'plus-full', 'original' or null. */
export function backupKind(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.app === ORIGINAL_APP_ID && Array.isArray(payload.transactions)) return 'original';
    if (payload.app === APP_ID && payload.kind === 'full' && Array.isArray(payload.profiles)) return 'plus-full';
    if (payload.app === APP_ID && Array.isArray(payload.transactions)) return 'plus-profile';
    return null;
}

export async function exportProfile(core, { name = null } = {}) {
    const { market, settings, plus } = core;
    const transactions = (await core.allTransactions())
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.createdAt).localeCompare(String(b.createdAt))))
        .map(({ createdAt, updatedAt, ...tx }) => tx);
    const customAssets = [];
    for (const asset of market.assets.values()) {
        if (asset.source !== 'custom') continue;
        customAssets.push({
            symbol: asset.symbol,
            name: asset.nameFa,
            unit: asset.unit,
            kind: asset.meta.kind || 'other',
            price: asset.price,
            history: await market.historyRows(asset.symbol),
        });
    }
    const prefs = settings.preferences();
    return {
        app: APP_ID,
        format: FORMAT,
        kind: 'profile',
        version: core.version,
        exportedAt: new Date().toISOString(),
        profile: { name },
        preferences: {
            watchlist: prefs.watchlist,
            displayUnit: prefs.displayUnit,
            chartRange: prefs.chartRange,
            refreshMinutes: prefs.refreshMinutes,
            provider: prefs.provider,
            iranMarket: prefs.iranMarket,
            navasan: prefs.navasan,
        },
        customAssets,
        stocks: plus.stocks ? plus.stocks.exportStocks([...transactions.map((tx) => tx.symbol), ...prefs.watchlist]) : [],
        cash: { sources: plus.cash.config() },
        locations: plus.locations.saved(),
        withdrawals: await plus.withdrawals.docs(),
        transactions,
    };
}

function mergeSources(current, incoming, replace) {
    const next = replace ? { custom: [], archived: [], renamed: {} } : { custom: [...current.custom], archived: [...current.archived], renamed: { ...current.renamed } };
    const ids = new Set(next.custom.map((item) => item.id));
    for (const item of Array.isArray(incoming.custom) ? incoming.custom : []) {
        if (!item || typeof item.id !== 'string' || !item.name || ids.has(item.id)) continue;
        ids.add(item.id);
        next.custom.push({ id: item.id.slice(0, 64), name: String(item.name).trim().slice(0, 60), createdAt: item.createdAt || null });
    }
    next.archived = [...new Set([...next.archived, ...(Array.isArray(incoming.archived) ? incoming.archived.map(String) : [])])];
    for (const [id, name] of Object.entries(incoming.renamed && typeof incoming.renamed === 'object' ? incoming.renamed : {})) {
        if (name) next.renamed[id] = String(name).trim().slice(0, 60);
    }
    return next;
}

function cleanWithdrawal(doc) {
    if (!doc || typeof doc.id !== 'string' || !isIsoDate(doc.date) || !Number.isFinite(Number(doc.amount)) || !Array.isArray(doc.allocations)) return null;
    return { ...doc, type: 'withdrawal', id: doc.id.slice(0, 64), amount: Number(doc.amount) };
}

/**
 * Restores a profile backup (or a file exported by the original DollarBaan) into this profile.
 * mode 'merge' adds to what is there; 'replace' makes the profile exactly match the file.
 */
export async function importProfile(core, payload, { mode = 'merge' } = {}) {
    const kind = backupKind(payload);
    if (!kind || kind === 'plus-full') {
        throw badRequest(kind === 'plus-full'
            ? 'این فایل پشتیبان کامل همه پروفایل‌هاست؛ از «بازیابی پشتیبان کامل» استفاده کنید'
            : 'فایل پشتیبان دلاربان یا دلاربان پلاس معتبر نیست');
    }
    const plusFile = kind === 'plus-profile';
    const replace = mode === 'replace';
    const { market, settings, plus, store } = core;
    // Files of the first release name gold funds by symbols that no longer exist.
    payload = plus.stocks ? await plus.stocks.remapLegacyBackup(payload) : payload;
    if (payload.transactions.length > MAX_TRANSACTIONS) throw badRequest('تعداد تراکنش‌های فایل بیش از حد مجاز است');

    // A brand new profile has no prices yet; fetch them once so the file's assets can be recognized.
    if (![...market.assets.values()].some((asset) => asset.source === 'market')) await market.sync({ reason: 'import' });

    const customAssets = [];
    for (const item of Array.isArray(payload.customAssets) ? payload.customAssets : []) {
        if (!item || !CUSTOM_SYMBOL.test(item.symbol)) throw badRequest('یکی از دارایی‌های دستی فایل پشتیبان معتبر نیست');
        const data = market.validateCustom({ name: item.name, unit: item.unit, kind: item.kind, price: item.price });
        const history = (Array.isArray(item.history) ? item.history : [])
            .filter((point) => point && isIsoDate(point.date) && Number(point.close) > 0)
            .map((point) => ({ date: point.date, close: Number(point.close) }));
        customAssets.push({ symbol: item.symbol, ...data, kind: CUSTOM_KINDS.includes(data.kind) ? data.kind : 'other', history });
    }
    const stockRows = plusFile && plus.stocks ? plus.stocks.stockRowsFromBackup(payload.stocks) : [];
    const known = new Set([...customAssets.map((asset) => asset.symbol), ...stockRows.map((row) => row.symbol), CASH_SYMBOL]);

    const unknown = new Set();
    const imported = [];
    for (const raw of payload.transactions) {
        const symbol = raw && String(raw.symbol || '');
        if (symbol && !market.getAsset(symbol) && !known.has(symbol)) {
            unknown.add(symbol);
            continue;
        }
        const data = core.validateTransaction(raw, { knownSymbols: known, trusted: plusFile });
        const id = raw.id && UUID.test(raw.id) ? raw.id.toLowerCase() : core.uuid();
        imported.push({ ...data, id });
    }
    if (unknown.size) throw badRequest(`این دارایی‌ها در منبع داده فعلی پیدا نشدند: ${[...unknown].slice(0, 8).join('، ')}`);

    const now = new Date();
    const existing = await core.allTransactions();
    const existingById = new Map(existing.map((tx) => [tx.id, tx]));
    const rows = imported.map((tx) => ({
        ...tx,
        createdAt: !replace && existingById.has(tx.id) ? existingById.get(tx.id).createdAt : now,
        updatedAt: now,
    }));
    const finalSet = new Map(replace ? [] : existing.map((tx) => [tx.id, tx]));
    for (const row of rows) finalSet.set(row.id, row);
    core.assertNoOversell([...finalSet.values()]);

    // Cash sources and withdrawals ride along with Plus files; replacing also clears what no longer applies.
    let docs = null;
    if (plusFile) {
        docs = (Array.isArray(payload.withdrawals) ? payload.withdrawals : []).map(cleanWithdrawal).filter(Boolean);
    } else if (replace) {
        docs = [];
    }
    if (plusFile) {
        await settings.set('cashSources', mergeSources(plus.cash.config(), payload.cash && payload.cash.sources ? payload.cash.sources : {}, replace));
        const saved = Array.isArray(payload.locations) ? payload.locations.map((name) => String(name).trim().slice(0, 80)).filter(Boolean) : [];
        await settings.set('locations', replace ? saved : [...new Set([...plus.locations.saved(), ...saved])]);
    } else if (replace) {
        await settings.set('cashSources', { custom: [], archived: [], renamed: {} });
    }

    const toAsset = (asset) => ({
        symbol: asset.symbol,
        source: 'custom',
        provider: null,
        nameFa: asset.nameFa,
        nameEn: null,
        category: 'custom',
        currency: 'IRT',
        unit: asset.unit,
        price: asset.price,
        prevClose: null,
        high: null,
        low: null,
        quoteTime: now,
        stale: false,
        listed: true,
        rateSymbol: null,
        meta: { kind: asset.kind },
        createdAt: now,
        updatedAt: now,
    });
    await store.importBackup({
        replace,
        transactions: rows,
        assets: [...customAssets.map(toAsset), ...stockRows.filter((row) => !market.getAsset(row.symbol))],
        prices: customAssets.flatMap((asset) => asset.history.map((point) => ({
            symbol: asset.symbol, date: point.date, open: point.close, high: point.close, low: point.close, close: point.close, origin: 'manual',
        }))),
        docs,
    });

    for (const asset of customAssets) market.history.delete(asset.symbol);
    await market.reloadAssets();
    await plus.cash.ensureAsset();
    await applyPreferences(core, payload.preferences, plusFile);
    market.trackNow([...new Set(imported.map((tx) => tx.symbol))]).catch(() => {});
    return {
        transactions: imported.length,
        customAssets: customAssets.length,
        stocks: stockRows.length,
        withdrawals: docs ? docs.length : 0,
    };
}

/** Restores the preferences found in a file; anything this installation cannot use is skipped. */
export async function applyPreferences(core, saved, plusFile) {
    if (!saved || typeof saved !== 'object') return;
    const { market, settings } = core;
    const patch = {};
    if (Array.isArray(saved.watchlist)) patch.watchlist = saved.watchlist.filter((symbol) => market.getAsset(symbol));
    for (const key of ['displayUnit', 'chartRange']) if (saved[key]) patch[key] = saved[key];
    if (plusFile) {
        if (saved.refreshMinutes) patch.refreshMinutes = saved.refreshMinutes;
        if (saved.iranMarket && typeof saved.iranMarket === 'object') patch.iranMarket = saved.iranMarket;
        if (settings.providers.includes(saved.provider) && (saved.provider !== 'navasan' || (saved.navasan && saved.navasan.apiKey))) {
            patch.provider = saved.provider;
            if (saved.navasan && saved.navasan.apiKey) patch.navasan = { apiKey: saved.navasan.apiKey };
        }
    }
    // Each setting is tried on its own so one value this installation rejects does not drop the rest.
    for (const [key, value] of Object.entries(patch)) {
        try {
            const { before, after } = await settings.updatePreferences({ [key]: value });
            await market.applyPreferences(before, after);
        } catch {
            /* skipped */
        }
    }
}
