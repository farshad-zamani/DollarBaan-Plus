// Profit withdrawals for DollarBaan Plus. A withdrawal takes profit out of one or several holdings
// (and/or out of cash). Each asset part becomes a "withdrawal" sale at the market price of that day:
// the units leave but the cost basis stays (see ledger.apply), so only profit is taken. The money
// either lands in cash or leaves the app. The record itself is a document; its rows carry its id.
import * as ledger from '../ledger.js';
import { CASH_SYMBOL } from '../catalog.js';
import { tehranDate, isIsoDate } from '../dates.js';
import { badRequest, notFound } from '../errors.js';
import { SOURCE_PROFIT_WITHDRAWAL } from './cash.js';
import { cleanLocation } from './locations.js';

export const WITHDRAWAL_DOC = 'withdrawal';
const TOLERANCE = 1e-6;
const MAX_AMOUNT = 1e15;

const round2 = (value) => Math.round(value * 100) / 100;

function cleanNote(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

export class WithdrawalCore {
    /**
     * @param {object} options
     * @param {object} options.store      storage adapter
     * @param {object} options.market     MarketCore
     * @param {object} options.portfolio  PlusPortfolioCore
     * @param {object} options.cash       CashCore
     * @param {object} options.platform   { uuid }
     */
    constructor({ store, market, portfolio, cash, platform }) {
        this.store = store;
        this.market = market;
        this.portfolio = portfolio;
        this.cash = cash;
        this.uuid = platform.uuid;
    }

    docs() {
        return this.store.listDocs(WITHDRAWAL_DOC);
    }

    checkDate(value) {
        const today = tehranDate();
        const date = value ? String(value) : today;
        if (!isIsoDate(date)) throw badRequest('تاریخ برداشت معتبر نیست');
        if (date > today) throw badRequest('تاریخ برداشت نمی‌تواند در آینده باشد');
        if (date < '1990-01-01') throw badRequest('تاریخ برداشت بیش از حد قدیمی است');
        return date;
    }

    /**
     * What could be withdrawn on a day: each holding's profit at that day's price (value minus cost,
     * after earlier withdrawals) and the cash balance.
     */
    async preview({ date } = {}) {
        const day = this.checkDate(date);
        const all = await this.portfolio.allTransactions();
        const assets = [];
        for (const [symbol, state] of ledger.replay(all.filter((tx) => tx.date <= day))) {
            if (symbol === CASH_SYMBOL || state.quantity <= ledger.EPSILON) continue;
            const asset = this.market.getAsset(symbol);
            if (!asset) continue;
            let price = null;
            let priceDate = null;
            try {
                const found = await this.market.priceAt(symbol, day);
                price = found.price;
                priceDate = found.date;
            } catch {
                price = null;
            }
            const view = this.market.view(asset);
            const value = price > 0 ? state.quantity * price : null;
            assets.push({
                symbol,
                name: view.name,
                category: view.category,
                unit: view.unit,
                quantity: state.quantity,
                price,
                priceDate,
                cost: state.cost,
                value,
                profit: value === null ? 0 : Math.max(0, value - state.cost),
                unrealized: value === null ? null : value - state.cost,
                withdrawn: state.withdrawn,
            });
        }
        assets.sort((a, b) => b.profit - a.profit);
        const { balance, byLocation } = this.cash.balanceAt(all, day);
        return {
            date: day,
            assets,
            cash: {
                balance: Math.max(0, balance),
                locations: [...byLocation.entries()].filter(([, amount]) => amount > 0).map(([location, amount]) => ({ location, amount })),
            },
            totalProfit: assets.reduce((sum, item) => sum + item.profit, 0),
        };
    }

    /** Splits `amount` across the chosen sources in proportion to what each can give. */
    autoSplit(amount, symbols, includeCash, preview) {
        const pool = [];
        for (const symbol of symbols) {
            const item = preview.assets.find((entry) => entry.symbol === symbol);
            if (!item || !(item.profit > 0)) continue;
            pool.push({ type: 'asset', symbol, cap: item.profit });
        }
        if (includeCash && preview.cash.balance > 0) pool.push({ type: 'cash', cap: preview.cash.balance });
        const capacity = pool.reduce((sum, item) => sum + item.cap, 0);
        if (!pool.length || amount > capacity * (1 + TOLERANCE)) {
            throw badRequest('مبلغ برداشت از مجموع سود قابل برداشت دارایی‌های انتخاب‌شده بیشتر است');
        }
        const parts = pool.map((item) => ({ ...item, amount: Math.min(item.cap, round2((amount * item.cap) / capacity)) }));
        // Rounding can leave a cent or two over or under: give it to the part with the most room.
        const drift = round2(amount - parts.reduce((sum, item) => sum + item.amount, 0));
        if (drift !== 0) {
            const target = parts.reduce((best, item) => (item.cap - item.amount > best.cap - best.amount ? item : best));
            target.amount = round2(Math.min(target.cap, Math.max(0, target.amount + drift)));
        }
        return parts.filter((item) => item.amount > 0).map(({ cap, ...rest }) => rest);
    }

    /**
     * input: { date, destination: 'cash'|'external', cashLocation, note,
     *          allocations: [{ type: 'asset', symbol, amount, price?, location? } | { type: 'cash', amount, location? }]
     *          OR amount + symbols (+ includeCash) for an automatic proportional split }
     */
    async create(input = {}) {
        const date = this.checkDate(input.date);
        const destination = input.destination === 'cash' ? 'cash' : 'external';
        const preview = await this.preview({ date });
        const note = cleanNote(input.note);

        let allocations;
        if (Array.isArray(input.allocations) && input.allocations.length) {
            allocations = input.allocations.map((item) => ({
                type: item && item.type === 'cash' ? 'cash' : 'asset',
                symbol: item && item.symbol ? String(item.symbol) : null,
                amount: Number(item && item.amount),
                price: item && item.price !== undefined && item.price !== null && item.price !== '' ? Number(item.price) : null,
                location: cleanLocation(item && item.location),
            }));
        } else if (Number(input.amount) > 0 && Array.isArray(input.symbols)) {
            allocations = this.autoSplit(Number(input.amount), input.symbols.map(String), Boolean(input.includeCash), preview)
                .map((item) => ({ ...item, price: null, location: '' }));
        } else {
            throw badRequest('مبلغ و دارایی‌هایی که سود از آن‌ها برداشت می‌شود را مشخص کنید');
        }

        const seen = new Set();
        const resolved = [];
        for (const item of allocations) {
            if (!Number.isFinite(item.amount) || item.amount <= 0 || item.amount > MAX_AMOUNT) throw badRequest('مبلغ هر بخش از برداشت باید عددی بزرگ‌تر از صفر باشد');
            if (item.type === 'cash') {
                if (destination === 'cash') throw badRequest('برداشت از پول نقد و واریز دوباره به پول نقد معنی ندارد');
                if (seen.has(CASH_SYMBOL)) throw badRequest('پول نقد فقط یک بار در هر برداشت می‌تواند بیاید');
                seen.add(CASH_SYMBOL);
                if (item.amount > preview.cash.balance * (1 + TOLERANCE)) throw badRequest('موجودی پول نقد برای این برداشت کافی نیست');
                resolved.push({ type: 'cash', amount: item.amount, location: item.location });
                continue;
            }
            const held = preview.assets.find((entry) => entry.symbol === item.symbol);
            if (!held) throw badRequest(`دارایی «${item.symbol || '—'}» در این تاریخ موجود نیست`);
            if (seen.has(item.symbol)) throw badRequest('هر دارایی فقط یک بار در هر برداشت می‌تواند بیاید');
            seen.add(item.symbol);
            const price = item.price > 0 ? item.price : held.price;
            if (!(price > 0)) throw badRequest(`قیمت «${held.name}» در این تاریخ پیدا نشد؛ قیمت را وارد کنید`);
            const quantity = item.amount / price;
            if (quantity > held.quantity * (1 + TOLERANCE)) throw badRequest(`مقدار لازم برای برداشت از «${held.name}» از موجودی شما بیشتر است`);
            const profit = Math.max(0, held.quantity * price - held.cost);
            if (item.amount > profit * (1 + TOLERANCE)) {
                throw badRequest(`سود قابل برداشت «${held.name}» فقط ${Math.floor(profit)} تومان است؛ فقط از سود می‌توان برداشت کرد`, 'exceeds_profit');
            }
            resolved.push({ type: 'asset', symbol: item.symbol, amount: item.amount, price, quantity: Math.min(quantity, held.quantity), location: item.location });
        }
        if (!resolved.length) throw badRequest('هیچ بخشی برای برداشت انتخاب نشده است');

        const id = this.uuid();
        const now = new Date();
        const base = { date, note: note || 'برداشت سود', fee: 0, withdrawalId: id, linkId: null, createdAt: now, updatedAt: now };
        const rows = [];
        const parts = [];
        for (const item of resolved) {
            const txId = this.uuid();
            if (item.type === 'asset') {
                rows.push({ ...base, id: txId, symbol: item.symbol, side: 'sell', quantity: item.quantity, unitPrice: item.price, location: item.location, sourceId: null, kind: 'withdrawal' });
                parts.push({ type: 'asset', symbol: item.symbol, amount: item.amount, quantity: item.quantity, price: item.price, location: item.location, txId });
            } else {
                rows.push({ ...base, id: txId, symbol: CASH_SYMBOL, side: 'sell', quantity: item.amount, unitPrice: 1, location: item.location, sourceId: null, kind: 'trade' });
                parts.push({ type: 'cash', amount: item.amount, location: item.location, txId });
            }
        }
        const total = resolved.reduce((sum, item) => sum + item.amount, 0);
        let depositTxId = null;
        const cashLocation = cleanLocation(input.cashLocation);
        if (destination === 'cash') {
            depositTxId = this.uuid();
            rows.push({ ...base, id: depositTxId, symbol: CASH_SYMBOL, side: 'buy', quantity: total, unitPrice: 1, location: cashLocation, sourceId: SOURCE_PROFIT_WITHDRAWAL, kind: 'trade' });
        }

        const symbols = new Set([CASH_SYMBOL, ...rows.map((row) => row.symbol)]);
        const existing = await this.portfolio.transactionsFor(symbols);
        this.portfolio.assertNoOversell([...existing, ...rows]);
        const doc = {
            id,
            type: WITHDRAWAL_DOC,
            date,
            amount: total,
            destination,
            cashLocation: destination === 'cash' ? cashLocation : '',
            note,
            allocations: parts,
            depositTxId,
            createdAt: now.toISOString(),
        };
        await this.store.writeBatch({ insert: rows, putDocs: [doc] });
        return this.describe(doc);
    }

    describe(doc) {
        return {
            ...doc,
            allocations: doc.allocations.map((part) => ({
                ...part,
                name: part.type === 'cash' ? 'پول نقد' : this.portfolio.assetName(part.symbol),
            })),
        };
    }

    /** All withdrawals, newest first, with totals. */
    async list() {
        const docs = (await this.docs())
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
        const items = docs.map((doc) => this.describe(doc));
        const sumOf = (type) => items.reduce((sum, item) => sum + item.allocations.filter((part) => part.type === type).reduce((s, part) => s + part.amount, 0), 0);
        return {
            items,
            totals: {
                count: items.length,
                amount: items.reduce((sum, item) => sum + item.amount, 0),
                fromAssets: sumOf('asset'),
                fromCash: sumOf('cash'),
                toCash: items.filter((item) => item.destination === 'cash').reduce((sum, item) => sum + item.amount, 0),
                external: items.filter((item) => item.destination !== 'cash').reduce((sum, item) => sum + item.amount, 0),
            },
        };
    }

    async find(id) {
        const doc = (await this.docs()).find((item) => item.id === id);
        if (!doc) throw notFound('برداشت پیدا نشد');
        return doc;
    }

    async updateNote(id, note) {
        const doc = await this.find(id);
        const next = { ...doc, note: cleanNote(note) };
        await this.store.putDoc(next);
        return this.describe(next);
    }

    /** Deleting a withdrawal puts the units back (its rows disappear) and removes the cash it moved. */
    async remove(id) {
        const doc = await this.find(id);
        const all = await this.portfolio.allTransactions();
        const rows = all.filter((tx) => tx.withdrawalId === doc.id);
        const gone = new Set(rows.map((tx) => tx.id));
        const touched = new Set([CASH_SYMBOL, ...rows.map((tx) => tx.symbol)]);
        this.portfolio.assertNoOversell(all.filter((tx) => touched.has(tx.symbol) && !gone.has(tx.id)));
        await this.store.writeBatch({ remove: [...gone], removeDocs: [doc.id] });
    }
}
