// Tehran stocks and funds for DollarBaan Plus: the whole exchange as a market, quotes and daily history.
// Every holdable instrument (shares, rights, funds, gold funds) is an ordinary asset (source "stock",
// symbol "STK_<insCode>") priced in toman, so the ledger, charts and profit/loss code treat them like any
// other holding. One market-watch request refreshes all of them; only the stocks a profile actually
// references (held or watched) get a daily price row and, on demand, their full history.
import { tehranDate, diffDays } from '../dates.js';
import { STOCK_PREFIX, isStockSymbol } from '../catalog.js';
import { badRequest, notFound } from '../errors.js';
import { TsetmcClient, isInsCode, persianText } from '../providers/tsetmc.js';
import { WITHDRAWAL_DOC } from './withdrawals.js';

const HISTORY_REFRESH_MS = 12 * 60 * 60 * 1000;
const CONCURRENCY = 3;
const MAX_TIMER_MS = 2 ** 31 - 1;
const STALE_QUOTE_DAYS = 10;
/** The first release priced gold funds from a feed with wrong units; they now come from the exchange. */
const LEGACY_FUND_PREFIX = 'IME_FUND_';

/** Gold funds of the first release's feed (symbol suffix) and the ticker they trade under on the exchange. */
const LEGACY_FUND_TICKERS = {
    ZOMOROD: 'زمرد', ZARVAN: 'زروان', ZARGAR: 'زرگر', ZARFAM: 'زرفام', ZAR: 'زر', TABESH: 'تابش', SAFRON: 'سافرون',
    ROZ_TORANJ: 'رز ترنج', ROSGOLD: 'رزگلد', RITON: 'ریتون', NEGIN_FARS: 'نگین فارس', NAHAL: 'نهال', NAFIS: 'نفیس',
    NAAB: 'ناب', MIRAS: 'میراث', MESGHAL: 'مثقال', LOTUSS: 'لوتوس', LIYAN: 'لیان', KAHROBA: 'کهربا', JAVAHER: 'جواهر',
    JAAM_TALA: 'جام طلا', HAMIYAN: 'همیان', GOLDIS: 'گلدیس', GOLDA: 'گلدا', GOHAR: 'گوهر', GHYRAT: 'قیراط', GANJ: 'گنج',
    EMERALD: 'امرالد', DORNA: 'درنا', DERAKHSHAN: 'درخشان', AYAR: 'عیار', ATASH: 'آتش', ALTON: 'آلتون',
};

export const stockSymbol = (insCode) => `${STOCK_PREFIX}${insCode}`;
export const insCodeOf = (symbol) => String(symbol).slice(STOCK_PREFIX.length);

/** Letters only, in one spelling: how a ticker is compared. */
const squash = (text) => persianText(text).replace(/[\s‌.\-_()]/g, '').toLowerCase();

export function describe(error) {
    if (error && error.code === 'not_found') return error.message;
    if (error && error.status === 403) {
        return 'سایت بورس (cdn.tsetmc.com) دسترسی را رد کرد (HTTP 403)؛ معمولاً به‌خاطر تعداد زیاد درخواست یا محدودیت آدرس IP است. چند دقیقه بعد دوباره تلاش کنید یا از اتصال دیگری استفاده کنید';
    }
    if (error && error.status) return `سرور بورس با خطای HTTP ${error.status} پاسخ داد`;
    return 'دریافت قیمت سهام ممکن نشد؛ اتصال اینترنت را بررسی کنید (سایت بورس از خارج از ایران یا بدون دسترسی مستقیم مرورگر ممکن است در دسترس نباشد)';
}

/** Copy of a document or backup with one symbol replaced wherever it appears as a value (symbol fields, watchlists). */
function renameSymbolIn(value, from, to) {
    if (value === from) return to;
    if (Array.isArray(value)) return value.map((item) => renameSymbolIn(item, from, to));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = renameSymbolIn(item, from, to);
        return out;
    }
    return value;
}

export class StocksCore {
    /**
     * @param {object} options
     * @param {object} options.store     storage adapter
     * @param {object} options.market    MarketCore (this core registers itself as market.extensions.stocks)
     * @param {object} options.settings  SettingsCore
     * @param {object} options.platform  { logger, fetchJson }
     */
    constructor({ store, market, settings, platform }) {
        this.store = store;
        this.market = market;
        this.settings = settings;
        this.logger = platform.logger;
        this.client = new TsetmcClient({ fetchJson: platform.fetchJson, logger: platform.logger });
        this.timer = null;
        this.syncing = null;
        this.historyFailures = new Map();
        this.status = { ok: null, error: null, catalogError: null, lastAttemptAt: null, lastSuccessAt: null, catalogAt: null, count: 0 };
        market.extensions.stocks = this;
    }

    async init() {
        const saved = this.settings.get('stockSyncState');
        if (saved && typeof saved === 'object') Object.assign(this.status, saved);
    }

    publicStatus() {
        return { ...this.status, running: Boolean(this.syncing), count: this.assets().length };
    }

    assets() {
        return [...this.market.assets.values()].filter((asset) => asset.source === 'stock');
    }

    /** Stocks this profile holds or watches: the ones that need daily prices and individual updates. */
    async referenced() {
        const symbols = new Set([...(await this.store.heldSymbols()), ...this.settings.preferences().watchlist]);
        return [...symbols].filter((symbol) => isStockSymbol(symbol) && this.market.assets.has(symbol));
    }

    /* ---------- scheduling ---------- */

    intervalMs() {
        return Math.max(5, this.settings.preferences().refreshMinutes) * 60 * 1000;
    }

    isStale() {
        const last = Date.parse(this.status.lastSuccessAt);
        // Never having tried the whole exchange (an update from the first release) also counts as stale.
        const neverListed = !this.status.catalogAt && !this.status.catalogError;
        return neverListed || !(this.status.ok && Number.isFinite(last) && Date.now() - last < this.intervalMs() && this.assets().length > 0);
    }

    start() {
        if (this.isStale()) this.sync({ reason: 'startup' });
        else this.schedule(this.intervalMs() - (Date.now() - Date.parse(this.status.lastSuccessAt)));
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = null;
    }

    schedule(delayMs) {
        clearTimeout(this.timer);
        const delay = Math.min(MAX_TIMER_MS, Math.max(1000, delayMs));
        this.timer = setTimeout(() => this.sync({ reason: 'schedule' }), delay);
        if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }

    /** Updates every stock, or joins the update already running. Never rejects. */
    sync({ reason = 'manual' } = {}) {
        if (!this.syncing) {
            this.syncing = this.runSync(reason).finally(() => {
                this.syncing = null;
            });
        }
        return this.syncing;
    }

    async runSync(reason) {
        this.status.lastAttemptAt = new Date().toISOString();
        this.logger.info(`Stock sync started (${reason})`);
        let ok = false;
        try {
            const fresh = reason === 'manual' || reason === 'resume' || reason === 'settings' || reason === 'import';
            let catalogFailure = null;
            let count = 0;
            try {
                const [rows, session] = await Promise.all([this.client.marketWatch({ fresh }), this.client.sessionInfo().catch(() => null)]);
                count = await this.storeCatalog(rows, session);
                this.status.catalogAt = new Date().toISOString();
                ok = true;
            } catch (error) {
                catalogFailure = error;
                this.logger.warn(`Stock market watch failed: ${error.message}`);
            }
            // Without the market watch the stocks the profile uses are still updated one by one.
            const refreshed = await this.refreshReferenced({ skipFresh: ok });
            if (!ok && refreshed.updated > 0) ok = true;
            Object.assign(this.status, {
                ok,
                error: ok ? null : describe(catalogFailure || refreshed.firstError),
                catalogError: catalogFailure ? describe(catalogFailure) : null,
                lastSuccessAt: ok ? new Date().toISOString() : this.status.lastSuccessAt,
                partial: refreshed.failed,
                catalogCount: count || this.status.catalogCount || 0,
            });
            if (ok) this.market.emit('synced');
        } catch (error) {
            Object.assign(this.status, { ok: false, error: describe(error) });
            this.logger.error(`Stock sync failed: ${error.message}`);
        } finally {
            await this.settings.set('stockSyncState', { ...this.status })
                .catch((error) => this.logger.error(`Cannot save stock sync state: ${error.message}`));
            this.schedule(this.status.ok ? this.intervalMs() : Math.min(this.intervalMs(), 10 * 60 * 1000));
        }
        return this.status;
    }

    /* ---------- the whole exchange ---------- */

    /** Stores the market watch as assets. Returns how many instruments were written. */
    async storeCatalog(rows, session) {
        const today = tehranDate();
        const date = session && session.date && session.date <= today ? session.date : today;
        const quoteTime = session && session.time && session.time.getTime() <= Date.now() ? session.time : (date === today ? new Date() : new Date(`${date}T12:30:00+03:30`));
        const stale = diffDays(date, today) > STALE_QUOTE_DAYS;
        const now = new Date();

        const assetRows = rows.map((row) => this.assetRow(row, {
            price: row.price, prevClose: row.prevClose, high: row.high, low: row.low, time: quoteTime, stale,
        }, now));
        const fresh = new Set(assetRows.map((row) => row.symbol));
        // Stocks added by hand (bonds and the like) are not in the market watch and stay listed.
        const vanished = this.assets()
            .filter((asset) => asset.listed && !fresh.has(asset.symbol) && !(asset.meta && asset.meta.manual))
            .map((asset) => asset.symbol);
        if (vanished.length) await this.store.setListed(vanished, false);
        await this.store.upsertAssets(assetRows);

        const wanted = await this.referenced();
        for (const symbol of wanted) {
            const row = rows.find((item) => stockSymbol(item.insCode) === symbol);
            if (row) await this.recordSnapshot(symbol, date, { price: row.price, open: row.open, high: row.high, low: row.low });
        }
        await this.market.reloadAssets();
        await this.migrateLegacyFunds().catch((error) => this.logger.warn(`Gold fund migration failed: ${error.message}`));
        return assetRows.length;
    }

    /** One daily price row for a stock (the latest trade of the session), without touching real history. */
    async recordSnapshot(symbol, date, { price, open, high, low }) {
        const today = tehranDate();
        const day = date && date <= today ? date : today;
        const existing = await this.store.getPrice(symbol, day);
        if (!existing) {
            await this.store.putPrice({ symbol, date: day, open: open || price, high: high || price, low: low || price, close: price, origin: 'snapshot' });
            this.market.history.delete(symbol);
        } else if (existing.origin !== 'provider' || day === today) {
            await this.store.putPrice({ ...existing, close: price, high: Math.max(Number(existing.high) || price, price), low: Math.min(Number(existing.low) || price, price) });
            this.market.history.delete(symbol);
        }
    }

    /** Updates the stocks a profile uses one by one (fallback when the market watch is unavailable). */
    async refreshReferenced({ skipFresh = false } = {}) {
        const result = { updated: 0, failed: 0, firstError: null };
        if (skipFresh) {
            // Only stocks the market watch did not list (added by hand) still need their own request.
            const symbols = (await this.referenced()).filter((symbol) => (this.market.getAsset(symbol).meta || {}).manual);
            return this.refreshMany(symbols, result);
        }
        return this.refreshMany(await this.referenced(), result);
    }

    async refreshMany(symbols, result) {
        const queue = [...symbols];
        const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            while (queue.length) {
                const symbol = queue.shift();
                try {
                    await this.refreshOne(this.market.getAsset(symbol), { reload: false });
                    result.updated += 1;
                } catch (error) {
                    result.failed += 1;
                    result.firstError = result.firstError || error;
                    this.logger.warn(`Stock ${symbol} failed: ${error.message}`);
                }
            }
        });
        await Promise.all(workers);
        if (symbols.length) await this.market.reloadAssets();
        return result;
    }

    /* ---------- one instrument ---------- */

    async refreshOne(asset, { reload = true } = {}) {
        const info = await this.client.info(insCodeOf(asset.symbol));
        const patch = {
            price: info.price,
            prevClose: info.prevClose,
            high: info.high,
            low: info.low,
            quoteTime: info.time || new Date(),
            stale: info.stale,
            updatedAt: new Date(),
        };
        await this.store.updateAsset(asset.symbol, patch);
        const today = tehranDate();
        const date = info.date && info.date <= today ? info.date : today;
        await this.recordSnapshot(asset.symbol, date, { price: info.price, open: info.open, high: info.high, low: info.low });
        if (reload) await this.market.reloadAssets();
    }

    /** What went wrong the last time the history of a symbol could not be fetched (or null). */
    historyFailure(symbol) {
        return this.historyFailures.get(symbol) || null;
    }

    /** Daily history from TSETMC, fetched when missing and refreshed twice a day (`force` skips the wait). */
    async ensureHistory(symbol, { force = false } = {}) {
        const asset = this.market.getAsset(symbol);
        if (!asset || asset.source !== 'stock') return { ok: true };
        const entry = (this.settings.get('historySync') || {})[symbol];
        if (!force && entry && entry.provider === 'tsetmc' && entry.count > 0 && Date.now() - Date.parse(entry.at) < HISTORY_REFRESH_MS) return { ok: true };
        const key = `tsetmc:${symbol}`;
        if (this.market.inflight.has(key)) return this.market.inflight.get(key);
        const task = (async () => {
            try {
                const rows = await this.client.history(insCodeOf(symbol));
                await this.market.storeHistory(symbol, rows);
                await this.market.markHistory(symbol, { at: new Date().toISOString(), provider: 'tsetmc', count: rows.length });
                this.historyFailures.delete(symbol);
                return { ok: true };
            } catch (error) {
                this.logger.warn(`History for ${symbol} failed: ${error.message}`);
                const message = `دریافت تاریخچهٔ قیمت از سایت بورس ممکن نشد. ${describe(error)}`;
                this.historyFailures.set(symbol, message);
                return { ok: false, error: message };
            }
        })().finally(() => this.market.inflight.delete(key));
        this.market.inflight.set(key, task);
        return task;
    }

    /** Called by MarketCore.trackNow for symbols that just became tracked (watchlist, import...). */
    async trackNow(symbols) {
        for (const symbol of symbols) if (isStockSymbol(symbol)) await this.ensureHistory(symbol);
    }

    /* ---------- other instruments (bonds and the like) ---------- */

    /** Searches the exchange itself, for instruments outside the market watch. */
    async search(query) {
        const text = String(query || '').trim();
        if (text.length < 2) return [];
        let results;
        try {
            results = await this.client.search(text);
        } catch (error) {
            throw badRequest(describe(error), 'stocks_unavailable');
        }
        return results.slice(0, 40).map((item) => ({
            ...item,
            symbol: stockSymbol(item.insCode),
            tracked: this.market.assets.has(stockSymbol(item.insCode)),
        }));
    }

    /** Adds an instrument that is not listed by default so it can be bought, sold and watched. */
    async track(insCode) {
        const code = String(insCode || '').trim();
        if (!isInsCode(code)) throw badRequest('نماد انتخاب‌شده معتبر نیست');
        const symbol = stockSymbol(code);
        const existing = this.market.getAsset(symbol);
        if (existing) return this.market.view(existing);

        let identity;
        let info;
        try {
            [identity, info] = await Promise.all([this.client.identity(code), this.client.info(code)]);
        } catch (error) {
            throw badRequest(describe(error), 'stocks_unavailable');
        }
        const now = new Date();
        await this.store.insertAsset(this.assetRow({ ...identity, category: 'stock' }, info, now, { manual: true }));
        await this.market.reloadAssets();
        await this.refreshOne(this.market.getAsset(symbol)).catch(() => {});
        this.ensureHistory(symbol).catch(() => {});
        if (!this.timer) this.schedule(this.intervalMs());
        return this.market.view(this.market.getAsset(symbol));
    }

    assetRow(identity, info, now = new Date(), { manual = false } = {}) {
        const meta = { insCode: identity.insCode, market: identity.market || null, sector: identity.sector || null, isin: identity.isin || null };
        if (identity.rights) meta.rights = true;
        if (manual) meta.manual = true;
        return {
            symbol: stockSymbol(identity.insCode),
            source: 'stock',
            provider: 'tsetmc',
            nameFa: identity.ticker,
            nameEn: identity.name,
            category: identity.category || 'stock',
            currency: 'IRT',
            unit: (identity.category || 'stock') === 'stock' ? 'share' : 'unit',
            price: info ? info.price : null,
            prevClose: info ? info.prevClose : null,
            high: info ? info.high : null,
            low: info ? info.low : null,
            quoteTime: info && info.time ? info.time : now,
            stale: info ? info.stale : true,
            listed: true,
            rateSymbol: null,
            meta,
            createdAt: now,
            updatedAt: now,
        };
    }

    /** Stops tracking a stock that has no transactions; its stored prices are removed too. */
    async untrack(symbol) {
        const asset = this.market.getAsset(symbol);
        if (!asset || asset.source !== 'stock') throw notFound('این سهم پیدا نشد');
        if (await this.store.countTransactions(symbol) > 0) {
            throw badRequest('برای این سهم تراکنش ثبت شده است؛ ابتدا تراکنش‌های آن را حذف کنید', 'in_use');
        }
        await this.store.deletePrices(symbol);
        await this.store.deleteAsset(symbol);
        this.market.history.delete(symbol);
        await this.market.reloadAssets();
    }

    /* ---------- backups ---------- */

    /** Stocks as stored in backups: only those a profile uses (history is downloaded again after a restore). */
    exportStocks(symbols = null) {
        const wanted = symbols ? new Set(symbols) : null;
        return this.assets()
            .filter((asset) => !wanted || wanted.has(asset.symbol))
            .map((asset) => ({
                symbol: asset.symbol,
                insCode: insCodeOf(asset.symbol),
                ticker: asset.nameFa,
                name: asset.nameEn || asset.nameFa,
                category: asset.category,
                market: (asset.meta && asset.meta.market) || null,
                sector: (asset.meta && asset.meta.sector) || null,
                price: asset.price,
                prevClose: asset.prevClose,
            }));
    }

    /** Asset rows for stocks listed in a backup. Prices are refreshed on the next sync. */
    stockRowsFromBackup(list) {
        const now = new Date();
        const rows = [];
        for (const item of Array.isArray(list) ? list : []) {
            if (!item || !isInsCode(item.insCode)) continue;
            const ticker = String(item.ticker || '').trim().slice(0, 40);
            if (!ticker) continue;
            const info = Number(item.price) > 0
                ? { price: Number(item.price), prevClose: Number(item.prevClose) > 0 ? Number(item.prevClose) : null, high: null, low: null, time: null, stale: true }
                : null;
            const category = ['stock', 'etf', 'fund'].includes(item.category) ? item.category : 'stock';
            rows.push(this.assetRow({
                insCode: String(item.insCode),
                ticker,
                name: String(item.name || ticker).trim().slice(0, 120),
                category,
                market: item.market ? String(item.market).slice(0, 60) : null,
                sector: item.sector ? String(item.sector).slice(0, 60) : null,
                isin: null,
            }, info, now, { manual: true }));
        }
        return rows;
    }

    /* ---------- gold funds of the first release ---------- */

    /** The exchange asset a legacy "IME_FUND_*" gold fund corresponds to, or null. */
    legacyFundTarget(legacy) {
        const known = LEGACY_FUND_TICKERS[String(legacy.symbol || '').slice(LEGACY_FUND_PREFIX.length)];
        const guess = known || String(legacy.nameFa || '').replace(/^\s*صندوق\s+طلای\s+/, '');
        const wanted = squash(guess);
        if (!wanted) return null;
        return this.assets().find((asset) => asset.listed && (asset.category === 'fund' || asset.category === 'etf') && squash(asset.nameFa) === wanted) || null;
    }

    /**
     * A backup written by the first release names gold funds by their old symbols. Returns a copy of it with
     * those replaced by the exchange symbols (loading the exchange list first when needed).
     */
    async remapLegacyBackup(payload) {
        const text = JSON.stringify(payload);
        const found = [...new Set(text.match(/IME_FUND_[A-Z_]+/g) || [])];
        if (!found.length) return payload;
        if (!this.assets().length) await this.sync({ reason: 'import' });
        let result = payload;
        for (const symbol of found) {
            const target = this.legacyFundTarget({ symbol });
            if (target) result = renameSymbolIn(result, symbol, target.symbol);
        }
        return result;
    }

    /**
     * Moves holdings of the old gold-fund symbols (wrong prices) to the real exchange symbols and removes
     * the unused leftovers. Funds that cannot be matched stay as they are.
     */
    async migrateLegacyFunds() {
        const legacy = [...this.market.assets.values()].filter((asset) => asset.source === 'market' && asset.symbol.startsWith(LEGACY_FUND_PREFIX));
        if (!legacy.length) return 0;
        const held = new Set(await this.store.heldSymbols());
        let watchlist = this.settings.preferences().watchlist;
        let moved = 0;
        for (const old of legacy) {
            const used = held.has(old.symbol) || watchlist.includes(old.symbol);
            const target = used ? this.legacyFundTarget(old) : null;
            if (used && !target) continue;
            if (target) {
                const rows = await this.store.transactionsFor([old.symbol]);
                const docs = await this.store.listDocs(WITHDRAWAL_DOC);
                await this.store.writeBatch({
                    update: rows.map((row) => ({ id: row.id, patch: { symbol: target.symbol } })),
                    putDocs: docs.filter((doc) => JSON.stringify(doc).includes(old.symbol)).map((doc) => renameSymbolIn(doc, old.symbol, target.symbol)),
                });
                if (watchlist.includes(old.symbol)) {
                    watchlist = [...new Set(watchlist.map((symbol) => (symbol === old.symbol ? target.symbol : symbol)))];
                    await this.settings.updatePreferences({ watchlist });
                }
                moved += 1;
            }
            await this.store.deletePrices(old.symbol);
            await this.store.deleteAsset(old.symbol);
            this.market.history.delete(old.symbol);
        }
        await this.market.reloadAssets();
        if (moved) this.logger.info(`Moved ${moved} gold fund holdings to their exchange symbols`);
        return moved;
    }
}
