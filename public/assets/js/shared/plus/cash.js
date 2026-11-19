// Cash (Toman) for DollarBaan Plus. Cash is a built-in asset priced at 1, so deposits are "buys" and
// spending is "sells": balances, portfolio value and charts need no special code. This module adds
// what cash needs on top: the user's own list of deposit sources and the reports built on them.
import { CASH_SYMBOL } from '../catalog.js';
import { badRequest, notFound, conflict } from '../errors.js';
import { isIsoDate, tehranDate } from '../dates.js';

export { CASH_SYMBOL };

export const SOURCE_ASSET_SALE = 'src_asset_sale';
export const SOURCE_PROFIT_WITHDRAWAL = 'src_profit_withdrawal';

// Ready-made deposit sources. The user can rename or hide them and add as many of their own as needed.
// "system" sources are used automatically by the app (a sale paid into cash, a profit withdrawal).
export const BUILTIN_SOURCES = [
    { id: 'src_profit_in_app', name: 'سود محقق‌شده در برنامه' },
    { id: 'src_profit_outside', name: 'سود محقق‌شده در خارج از برنامه' },
    { id: 'src_savings_outside', name: 'پس‌انداز خارج از برنامه' },
    { id: 'src_salary', name: 'حقوق و درآمد کاری' },
    { id: SOURCE_ASSET_SALE, name: 'فروش دارایی در برنامه', system: true },
    { id: SOURCE_PROFIT_WITHDRAWAL, name: 'برداشت سود از دارایی‌ها', system: true },
    { id: 'src_gift', name: 'هدیه یا ارث' },
    { id: 'src_loan', name: 'وام یا قرض' },
    { id: 'src_other', name: 'سایر' },
];

const NO_LOCATION = 'بدون محل نگهداری';
const MAX_SOURCES = 100;

export function cashAssetRow(now = new Date()) {
    return {
        symbol: CASH_SYMBOL,
        source: 'system',
        provider: null,
        nameFa: 'پول نقد',
        nameEn: 'Cash (Toman)',
        category: 'cash',
        currency: 'IRT',
        unit: 'toman',
        price: 1,
        prevClose: 1,
        high: null,
        low: null,
        quoteTime: now,
        stale: false,
        listed: true,
        rateSymbol: null,
        meta: { system: true },
        createdAt: now,
        updatedAt: now,
    };
}

function cleanName(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 60);
}

function normalizeConfig(raw) {
    const config = raw && typeof raw === 'object' ? raw : {};
    return {
        custom: Array.isArray(config.custom) ? config.custom.filter((item) => item && item.id && item.name) : [],
        archived: Array.isArray(config.archived) ? config.archived.map(String) : [],
        renamed: config.renamed && typeof config.renamed === 'object' ? { ...config.renamed } : {},
    };
}

export class CashCore {
    /**
     * @param {object} options
     * @param {object} options.store      storage adapter
     * @param {object} options.market     MarketCore
     * @param {object} options.settings   SettingsCore
     * @param {object} options.portfolio  PlusPortfolioCore
     * @param {object} options.platform   { uuid }
     */
    constructor({ store, market, settings, portfolio, platform }) {
        this.store = store;
        this.market = market;
        this.settings = settings;
        this.portfolio = portfolio;
        this.uuid = platform.uuid;
    }

    /** Makes sure this profile has the built-in cash asset. */
    async ensureAsset() {
        if (this.market.getAsset(CASH_SYMBOL)) return;
        await this.store.upsertAssets([cashAssetRow()]);
        await this.market.reloadAssets();
    }

    /* ---------- deposit sources ---------- */

    config() {
        return normalizeConfig(this.settings.get('cashSources'));
    }

    /** Sources in display order: built-ins first, then the user's own. */
    sources({ includeArchived = false } = {}) {
        const config = this.config();
        const archived = new Set(config.archived);
        const list = [
            ...BUILTIN_SOURCES.map((item) => ({
                id: item.id,
                name: cleanName(config.renamed[item.id]) || item.name,
                builtin: true,
                system: Boolean(item.system),
                archived: archived.has(item.id),
            })),
            ...config.custom.map((item) => ({
                id: item.id,
                name: item.name,
                builtin: false,
                system: false,
                archived: archived.has(item.id),
                createdAt: item.createdAt || null,
            })),
        ];
        return includeArchived ? list : list.filter((item) => !item.archived);
    }

    sourceName(id) {
        const found = this.sources({ includeArchived: true }).find((item) => item.id === id);
        return found ? found.name : null;
    }

    hasSource(id) {
        return this.sources({ includeArchived: true }).some((item) => item.id === id);
    }

    assertUniqueName(name, exceptId = null) {
        const key = name.toLowerCase();
        const clash = this.sources({ includeArchived: true }).some((item) => item.id !== exceptId && item.name.toLowerCase() === key);
        if (clash) throw conflict('منبعی با این نام قبلاً تعریف شده است');
    }

    async createSource({ name } = {}) {
        const clean = cleanName(name);
        if (!clean) throw badRequest('نام منبع را وارد کنید');
        const config = this.config();
        if (config.custom.length >= MAX_SOURCES) throw badRequest('تعداد منبع‌های تعریف‌شده به سقف مجاز رسیده است');
        this.assertUniqueName(clean);
        const source = { id: `src_${this.uuid().replace(/-/g, '').slice(0, 12)}`, name: clean, createdAt: new Date().toISOString() };
        config.custom.push(source);
        await this.settings.set('cashSources', config);
        return this.sources({ includeArchived: true }).find((item) => item.id === source.id);
    }

    async updateSource(id, { name, archived } = {}) {
        const config = this.config();
        const known = this.sources({ includeArchived: true }).find((item) => item.id === id);
        if (!known) throw notFound('منبع پیدا نشد');
        if (name !== undefined) {
            const clean = cleanName(name);
            if (!clean) throw badRequest('نام منبع را وارد کنید');
            this.assertUniqueName(clean, id);
            if (known.builtin) config.renamed[id] = clean;
            else config.custom = config.custom.map((item) => (item.id === id ? { ...item, name: clean } : item));
        }
        if (archived !== undefined) {
            if (known.system && archived) throw badRequest('این منبع را برنامه خودکار استفاده می‌کند و قابل مخفی کردن نیست');
            const set = new Set(config.archived);
            if (archived) set.add(id);
            else set.delete(id);
            config.archived = [...set];
        }
        await this.settings.set('cashSources', config);
        return this.sources({ includeArchived: true }).find((item) => item.id === id);
    }

    /** Only the user's own sources can be deleted, and only while nothing was deposited from them. */
    async deleteSource(id) {
        const config = this.config();
        if (!config.custom.some((item) => item.id === id)) {
            throw this.hasSource(id) ? badRequest('منبع‌های آماده حذف نمی‌شوند؛ می‌توانید آن‌ها را مخفی کنید') : notFound('منبع پیدا نشد');
        }
        const used = (await this.portfolio.transactionsFor([CASH_SYMBOL])).some((tx) => tx.sourceId === id);
        if (used) throw conflict('از این منبع وجهی واریز شده است؛ به‌جای حذف، آن را مخفی کنید تا گزارش‌ها حفظ شود');
        config.custom = config.custom.filter((item) => item.id !== id);
        config.archived = config.archived.filter((item) => item !== id);
        await this.settings.set('cashSources', config);
    }

    /* ---------- balance and reports ---------- */

    /**
     * Cash balance and per-location balances at the end of `date` (all history when omitted).
     * Money spent without naming a location is taken from the named places, largest first, so no
     * place shows a negative balance just because the where was left out.
     */
    balanceAt(transactions, date = null) {
        const byLocation = new Map();
        let balance = 0;
        for (const tx of transactions) {
            if (tx.symbol !== CASH_SYMBOL || (date && tx.date > date)) continue;
            const signed = tx.side === 'buy' ? tx.quantity : -tx.quantity;
            balance += signed;
            const key = tx.location || '';
            byLocation.set(key, (byLocation.get(key) || 0) + signed);
        }
        let deficit = -(byLocation.get('') || 0);
        if (deficit > 0) {
            byLocation.delete('');
            for (const [key, amount] of [...byLocation.entries()].sort((a, b) => b[1] - a[1])) {
                if (deficit <= 1e-9) break;
                const taken = Math.min(Math.max(0, amount), deficit);
                byLocation.set(key, amount - taken);
                deficit -= taken;
            }
        }
        return { balance, byLocation };
    }

    /**
     * Everything the cash page shows: balance, balance per location, deposits grouped by source
     * (with totals and counts) and the full history. Filters are optional.
     */
    async overview({ from = null, to = null, sourceId = null, location = null, direction = null } = {}) {
        if (from && !isIsoDate(from)) throw badRequest('تاریخ شروع معتبر نیست');
        if (to && !isIsoDate(to)) throw badRequest('تاریخ پایان معتبر نیست');
        const all = await this.portfolio.allTransactions();
        const names = new Map(all.map((tx) => [tx.id, tx]));
        const cash = all.filter((tx) => tx.symbol === CASH_SYMBOL);
        const { balance, byLocation } = this.balanceAt(cash);

        const sources = this.sources({ includeArchived: true });
        const sourceLabel = (id) => (id ? (sources.find((item) => item.id === id) || {}).name || 'منبع حذف‌شده' : 'بدون منبع');

        const filtered = cash.filter((tx) => {
            if (from && tx.date < from) return false;
            if (to && tx.date > to) return false;
            if (sourceId && (tx.side !== 'buy' || (tx.sourceId || '') !== (sourceId === 'none' ? '' : sourceId))) return false;
            if (location !== null && location !== undefined && location !== '' && (tx.location || '') !== (location === '__none__' ? '' : location)) return false;
            if (direction === 'in' && tx.side !== 'buy') return false;
            if (direction === 'out' && tx.side !== 'sell') return false;
            return true;
        });

        const bySource = new Map();
        let totalIn = 0;
        let totalOut = 0;
        for (const tx of filtered) {
            if (tx.side === 'buy') {
                totalIn += tx.quantity;
                const key = tx.sourceId || '';
                const entry = bySource.get(key) || { sourceId: key || null, name: sourceLabel(key), total: 0, count: 0, firstDate: tx.date, lastDate: tx.date };
                entry.total += tx.quantity;
                entry.count += 1;
                if (tx.date < entry.firstDate) entry.firstDate = tx.date;
                if (tx.date > entry.lastDate) entry.lastDate = tx.date;
                bySource.set(key, entry);
            } else {
                totalOut += tx.quantity;
            }
        }

        const history = [...filtered]
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || String(b.createdAt).localeCompare(String(a.createdAt)))
            .map((tx) => {
                const main = tx.linkId ? names.get(tx.linkId) : null;
                let reason = null;
                if (main) reason = `${main.side === 'buy' ? 'خرید' : 'فروش'} ${this.portfolio.assetName(main.symbol)}`;
                else if (tx.withdrawalId) reason = 'برداشت سود';
                return {
                    id: tx.id,
                    date: tx.date,
                    side: tx.side,
                    amount: tx.quantity,
                    sourceId: tx.sourceId || null,
                    sourceName: tx.side === 'buy' ? sourceLabel(tx.sourceId) : null,
                    location: tx.location || '',
                    note: tx.note || '',
                    linkId: tx.linkId || null,
                    withdrawalId: tx.withdrawalId || null,
                    reason,
                };
            });

        return {
            today: tehranDate(),
            balance,
            locations: [...byLocation.entries()]
                .filter(([, amount]) => Math.abs(amount) > 1e-9)
                .map(([name, amount]) => ({ location: name, label: name || NO_LOCATION, amount }))
                .sort((a, b) => b.amount - a.amount),
            sources: sources.filter((item) => !item.archived || bySource.has(item.id)),
            totals: { in: totalIn, out: totalOut, count: filtered.length },
            bySource: [...bySource.values()].sort((a, b) => b.total - a.total),
            history,
        };
    }
}
