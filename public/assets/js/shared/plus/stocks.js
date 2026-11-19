// Tehran stocks and funds for DollarBaan Plus: search, tracking, quotes and daily history.
// Stocks are ordinary assets (source "stock", symbol "STK_<insCode>") priced in toman, so the
// ledger, charts and profit/loss code treat them like any other holding.
import { tehranDate } from '../dates.js';
import { STOCK_PREFIX, isStockSymbol } from '../catalog.js';
import { badRequest, notFound } from '../errors.js';
import { TsetmcClient, isInsCode } from '../providers/tsetmc.js';

const HISTORY_REFRESH_MS = 12 * 60 * 60 * 1000;
const CONCURRENCY = 3;
const MAX_TIMER_MS = 2 ** 31 - 1;

export const stockSymbol = (insCode) => `${STOCK_PREFIX}${insCode}`;
export const insCodeOf = (symbol) => String(symbol).slice(STOCK_PREFIX.length);

function describe(error) {
    if (error && error.code === 'not_found') return error.message;
    if (error && error.status) return `سرور بورس با خطای HTTP ${error.status} پاسخ داد`;
    return 'دریافت قیمت سهام ممکن نشد؛ اتصال اینترنت را بررسی کنید (سایت بورس از خارج از ایران یا بدون دسترسی مستقیم مرورگر ممکن است در دسترس نباشد)';
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
        this.status = { ok: null, error: null, lastAttemptAt: null, lastSuccessAt: null, count: 0 };
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

    /* ---------- scheduling ---------- */

    intervalMs() {
        return Math.max(5, this.settings.preferences().refreshMinutes) * 60 * 1000;
    }

    isStale() {
        const last = Date.parse(this.status.lastSuccessAt);
        return !(this.status.ok && Number.isFinite(last) && Date.now() - last < this.intervalMs());
    }

    start() {
        if (!this.assets().length) return;
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

    /** Refreshes every tracked stock, or joins the refresh already running. Never rejects. */
    sync({ reason = 'manual' } = {}) {
        if (!this.syncing) {
            this.syncing = this.runSync(reason).finally(() => {
                this.syncing = null;
            });
        }
        return this.syncing;
    }

    async runSync(reason) {
        const assets = this.assets();
        if (!assets.length) return this.status;
        this.status.lastAttemptAt = new Date().toISOString();
        this.logger.info(`Stock sync started (${reason}): ${assets.length} symbols`);
        let failed = 0;
        let firstError = null;
        try {
            const queue = [...assets];
            const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
                while (queue.length) {
                    const asset = queue.shift();
                    try {
                        await this.refreshOne(asset, { reload: false });
                    } catch (error) {
                        failed += 1;
                        firstError = firstError || error;
                        this.logger.warn(`Stock ${asset.symbol} failed: ${error.message}`);
                    }
                }
            });
            await Promise.all(workers);
            await this.market.reloadAssets();
            const ok = failed < assets.length;
            Object.assign(this.status, {
                ok,
                error: ok ? null : describe(firstError),
                lastSuccessAt: ok ? new Date().toISOString() : this.status.lastSuccessAt,
                partial: ok && failed > 0 ? failed : 0,
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
        const existing = await this.store.getPrice(asset.symbol, date);
        const close = info.price;
        if (!existing) {
            await this.store.putPrice({ symbol: asset.symbol, date, open: info.open || close, high: info.high || close, low: info.low || close, close, origin: 'snapshot' });
            this.market.history.delete(asset.symbol);
        } else if (existing.origin !== 'provider' || date === today) {
            await this.store.putPrice({ ...existing, close, high: Math.max(Number(existing.high) || close, close), low: Math.min(Number(existing.low) || close, close) });
            this.market.history.delete(asset.symbol);
        }
        if (reload) await this.market.reloadAssets();
    }

    /** Daily history from TSETMC, fetched when missing and refreshed twice a day. */
    async ensureHistory(symbol) {
        const asset = this.market.getAsset(symbol);
        if (!asset || asset.source !== 'stock') return;
        const entry = (this.settings.get('historySync') || {})[symbol];
        if (entry && entry.provider === 'tsetmc' && Date.now() - Date.parse(entry.at) < HISTORY_REFRESH_MS) return;
        const key = `tsetmc:${symbol}`;
        if (this.market.inflight.has(key)) return this.market.inflight.get(key);
        const task = (async () => {
            try {
                const rows = await this.client.history(insCodeOf(symbol));
                await this.market.storeHistory(symbol, rows);
                await this.market.markHistory(symbol, { at: new Date().toISOString(), provider: 'tsetmc', count: rows.length });
            } catch (error) {
                this.logger.warn(`History for ${symbol} failed: ${error.message}`);
            }
        })().finally(() => this.market.inflight.delete(key));
        this.market.inflight.set(key, task);
        return task;
    }

    /** Called by MarketCore.trackNow for symbols that just became tracked (watchlist, import...). */
    async trackNow(symbols) {
        for (const symbol of symbols) if (isStockSymbol(symbol)) await this.ensureHistory(symbol);
    }

    /* ---------- search and tracking ---------- */

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

    /** Adds an instrument to this profile so it can be bought, sold and watched. Returns its asset view. */
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
        await this.store.insertAsset(this.assetRow(identity, info, now));
        await this.market.reloadAssets();
        await this.refreshOne(this.market.getAsset(symbol)).catch(() => {});
        this.ensureHistory(symbol).catch(() => {});
        if (!this.timer) this.schedule(this.intervalMs());
        return this.market.view(this.market.getAsset(symbol));
    }

    assetRow(identity, info, now = new Date()) {
        return {
            symbol: stockSymbol(identity.insCode),
            source: 'stock',
            provider: 'tsetmc',
            nameFa: identity.ticker,
            nameEn: identity.name,
            category: 'stock',
            currency: 'IRT',
            unit: 'share',
            price: info ? info.price : null,
            prevClose: info ? info.prevClose : null,
            high: info ? info.high : null,
            low: info ? info.low : null,
            quoteTime: info && info.time ? info.time : now,
            stale: info ? info.stale : true,
            listed: true,
            rateSymbol: null,
            meta: { insCode: identity.insCode, market: identity.market, sector: identity.sector, isin: identity.isin },
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

    /** Tracked stocks as stored in backups (history is downloaded again after a restore). */
    exportStocks() {
        return this.assets().map((asset) => ({
            symbol: asset.symbol,
            insCode: insCodeOf(asset.symbol),
            ticker: asset.nameFa,
            name: asset.nameEn || asset.nameFa,
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
            rows.push(this.assetRow({
                insCode: String(item.insCode),
                ticker,
                name: String(item.name || ticker).trim().slice(0, 120),
                market: item.market ? String(item.market).slice(0, 60) : null,
                sector: item.sector ? String(item.sector).slice(0, 60) : null,
                isin: null,
            }, info, now));
        }
        return rows;
    }
}
