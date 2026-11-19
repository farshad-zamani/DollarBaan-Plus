// DollarBaan Plus portfolio: upstream's PortfolioCore extended with storage locations, cash linked to
// trades, profit-withdrawal rows and per-holding lots. Everything else (validation, oversell checks,
// timelines) is inherited, so changes to upstream's core keep flowing in when it is merged.
import { PortfolioCore } from '../core/portfolio.js';
import * as ledger from '../ledger.js';
import { CASH_SYMBOL } from '../catalog.js';
import { toJalali, faDigits } from '../dates.js';
import { badRequest, notFound } from '../errors.js';
import { cleanLocation } from './locations.js';
import { SOURCE_ASSET_SALE } from './cash.js';
import { buildLots, locationBreakdown } from './lots.js';
import { exportProfile, importProfile } from './backup.js';

export function toPlusTx(data) {
    return {
        id: data.id,
        symbol: data.symbol,
        side: data.side,
        quantity: Number(data.quantity),
        unitPrice: Number(data.unitPrice),
        fee: Number(data.fee) || 0,
        date: data.date,
        note: data.note || '',
        location: data.location || '',
        sourceId: data.sourceId || null,
        kind: data.kind === 'withdrawal' ? 'withdrawal' : 'trade',
        linkId: data.linkId || null,
        withdrawalId: data.withdrawalId || null,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
    };
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const LOCKED = 'این تراکنش بخشی از یک برداشت سود است؛ برای تغییر یا حذف آن، برداشت را از بخش «سود و زیان» حذف و دوباره ثبت کنید';

export class PlusPortfolioCore extends PortfolioCore {
    constructor(options) {
        super(options);
        /** Set by the runtime: { cash, locations, withdrawals, stocks }. */
        this.plus = {};
    }

    attach(plus) {
        this.plus = plus;
    }

    /* ---------- rows keep their Plus fields ---------- */

    async transactionsFor(symbols) {
        return (await this.store.transactionsFor([...symbols])).map(toPlusTx);
    }

    async allTransactions() {
        return (await this.store.allTransactions()).map(toPlusTx);
    }

    async reload(id) {
        return this.withAsset(toPlusTx(await this.store.getTransaction(id)));
    }

    /* ---------- validation ---------- */

    /**
     * Adds the Plus fields. Cash always costs exactly 1 and has no fee; adding to cash needs a source.
     * `trusted` (backup restore) also accepts the links between rows, which users cannot set directly.
     */
    validateTransaction(input, options = {}) {
        if (!input || typeof input !== 'object') throw badRequest('اطلاعات تراکنش معتبر نیست');
        const isCash = input.symbol === CASH_SYMBOL;
        const data = super.validateTransaction(isCash ? { ...input, unitPrice: 1, fee: 0 } : input, options);
        data.location = cleanLocation(input.location);
        data.sourceId = null;
        if (isCash && data.side === 'buy') {
            const id = String(input.sourceId || '').trim().slice(0, 64);
            if (!id) throw badRequest('منبع افزودن وجه را مشخص کنید');
            if (!options.trusted && this.plus.cash && !this.plus.cash.hasSource(id)) throw badRequest('منبع انتخاب‌شده معتبر نیست');
            data.sourceId = id;
        }
        if (options.trusted) {
            data.kind = input.kind === 'withdrawal' ? 'withdrawal' : 'trade';
            data.linkId = input.linkId ? String(input.linkId).slice(0, 64) : null;
            data.withdrawalId = input.withdrawalId ? String(input.withdrawalId).slice(0, 64) : null;
        }
        return data;
    }

    assertNoOversell(transactions) {
        const issue = ledger.findOversell(transactions);
        if (issue && issue.symbol === CASH_SYMBOL) {
            throw badRequest(
                `موجودی پول نقد در تاریخ ${faDigits(toJalali(issue.date))} برای این عملیات کافی نیست (موجودی آن روز: ${faDigits(Math.floor(issue.available))} تومان)`,
                'insufficient_cash'
            );
        }
        super.assertNoOversell(transactions);
    }

    /* ---------- transactions with an optional linked cash entry ---------- */

    /**
     * The cash entry that mirrors a trade: buying spends cash, selling adds the proceeds.
     * `link` carries { location } for where that cash is kept.
     */
    cashCounterpart(main, link = {}) {
        const total = main.quantity * main.unitPrice;
        const amount = main.side === 'buy' ? total + main.fee : total - main.fee;
        if (!(amount > 0)) throw badRequest('مبلغ این تراکنش برای ثبت در پول نقد معتبر نیست');
        return {
            id: this.uuid(),
            symbol: CASH_SYMBOL,
            side: main.side === 'buy' ? 'sell' : 'buy',
            quantity: amount,
            unitPrice: 1,
            fee: 0,
            date: main.date,
            note: `${main.side === 'buy' ? 'خرید' : 'فروش'} ${this.assetName(main.symbol)}`.slice(0, 500),
            location: cleanLocation(link.location),
            sourceId: main.side === 'buy' ? null : SOURCE_ASSET_SALE,
            kind: 'trade',
            linkId: main.id,
            withdrawalId: null,
            createdAt: main.createdAt,
            updatedAt: main.updatedAt,
        };
    }

    async createTransaction(input) {
        const link = input && input.cash && input.cash.link === true ? input.cash : null;
        if (!link) return this.reload((await super.createTransaction(input)).id);

        const data = this.validateTransaction(input);
        if (data.symbol === CASH_SYMBOL) throw badRequest('برای خود پول نقد، ثبت همزمان کسر یا افزودن نقد معنی ندارد');
        const now = new Date();
        const main = { id: this.uuid(), ...data, createdAt: now, updatedAt: now };
        const counterpart = this.cashCounterpart(main, link);
        const existing = await this.transactionsFor([data.symbol, CASH_SYMBOL]);
        this.assertNoOversell([...existing, main, counterpart]);
        await this.store.writeBatch({ insert: [main, counterpart] });
        this.market.trackNow([data.symbol]).catch((error) => this.logger.warn(`Tracking ${data.symbol} failed: ${error.message}`));
        return this.withAsset(toPlusTx(main));
    }

    async updateTransaction(id, input) {
        const current = await this.store.getTransaction(id);
        if (!current) throw notFound('تراکنش پیدا نشد');
        if (current.withdrawalId) throw badRequest(LOCKED);

        const all = await this.allTransactions();
        const linked = all.filter((tx) => tx.linkId === id);
        const directive = input && input.cash;
        const wantLink = directive && 'link' in directive ? Boolean(directive.link) : linked.length > 0;
        if (!linked.length && !wantLink) {
            await super.updateTransaction(id, input);
            return this.reload(id);
        }

        const data = this.validateTransaction(input);
        if (data.symbol === CASH_SYMBOL && wantLink) throw badRequest('برای خود پول نقد، ثبت همزمان کسر یا افزودن نقد معنی ندارد');
        const now = new Date();
        const main = { ...toPlusTx(current), ...data, id, updatedAt: now };
        const batch = { update: [{ id, patch: { ...data, updatedAt: now } }], insert: [], remove: [] };
        let counterpart = null;
        if (wantLink) {
            const [existing, ...extra] = linked;
            const built = this.cashCounterpart(main, { location: directive && directive.location !== undefined ? directive.location : existing && existing.location });
            if (existing) {
                const patch = { side: built.side, quantity: built.quantity, date: built.date, note: built.note, location: built.location, sourceId: built.sourceId, updatedAt: now };
                batch.update.push({ id: existing.id, patch });
                counterpart = { ...existing, ...patch };
                batch.remove.push(...extra.map((tx) => tx.id));
            } else {
                batch.insert.push(built);
                counterpart = built;
            }
        } else {
            batch.remove.push(...linked.map((tx) => tx.id));
        }

        const touched = new Set([current.symbol, data.symbol, CASH_SYMBOL]);
        const gone = new Set([id, ...linked.map((tx) => tx.id)]);
        const rest = all.filter((tx) => touched.has(tx.symbol) && !gone.has(tx.id));
        this.assertNoOversell([...rest, main, ...(counterpart ? [counterpart] : [])]);
        await this.store.writeBatch(batch);
        if (data.symbol !== current.symbol) this.market.trackNow([data.symbol]).catch(() => {});
        return this.reload(id);
    }

    async deleteTransaction(id) {
        const current = await this.store.getTransaction(id);
        if (!current) throw notFound('تراکنش پیدا نشد');
        if (current.withdrawalId) throw badRequest(LOCKED);
        const all = await this.allTransactions();
        const linked = all.filter((tx) => tx.linkId === id);
        const gone = new Set([id, ...linked.map((tx) => tx.id)]);
        const touched = new Set([current.symbol, ...linked.map((tx) => tx.symbol)]);
        this.assertNoOversell(all.filter((tx) => touched.has(tx.symbol) && !gone.has(tx.id)));
        await this.store.writeBatch({ remove: [...gone] });
    }

    /* ---------- holdings with lots and locations ---------- */

    async getPortfolio() {
        const portfolio = await super.getPortfolio();
        const bySymbol = new Map();
        for (const tx of await this.allTransactions()) {
            if (!bySymbol.has(tx.symbol)) bySymbol.set(tx.symbol, []);
            bySymbol.get(tx.symbol).push(tx);
        }
        for (const holding of portfolio.holdings) {
            const list = bySymbol.get(holding.symbol) || [];
            holding.locations = locationBreakdown(list, holding.price);
            holding.lotCount = list.length;
        }
        return portfolio;
    }

    async getAssetDetail(symbol) {
        const detail = await super.getAssetDetail(symbol);
        const price = detail.holding ? detail.holding.price : detail.asset.price;
        detail.lots = buildLots(detail.transactions, price);
        detail.locations = locationBreakdown(detail.transactions, price);
        return detail;
    }

    /** Lots and location split of one holding (loaded when its row is expanded). */
    async getLots(symbol) {
        const asset = this.market.getAsset(symbol);
        if (!asset) throw notFound('این دارایی پیدا نشد');
        const transactions = await this.transactionsFor([symbol]);
        const price = this.market.toman(asset).price;
        return { symbol, lots: buildLots(transactions, price), locations: locationBreakdown(transactions, price) };
    }

    /* ---------- exports ---------- */

    async exportCsv() {
        const header = ['تاریخ (شمسی)', 'تاریخ (میلادی)', 'دارایی', 'نماد', 'نوع', 'مقدار', 'قیمت واحد (تومان)', 'کارمزد (تومان)', 'مبلغ کل (تومان)', 'محل نگهداری', 'یادداشت'];
        const lines = [header.map(csvCell).join(',')];
        const label = (tx) => {
            if (tx.kind === 'withdrawal') return 'برداشت سود';
            return tx.side === 'buy' ? 'خرید' : 'فروش';
        };
        for (const tx of (await this.listTransactions()).reverse()) {
            lines.push([
                toJalali(tx.date),
                tx.date,
                tx.name,
                tx.symbol,
                label(tx),
                tx.quantity,
                tx.unitPrice,
                tx.fee,
                tx.side === 'buy' ? tx.total + tx.fee : tx.total - tx.fee,
                tx.location,
                tx.note,
            ].map(csvCell).join(','));
        }
        return `﻿${lines.join('\r\n')}\r\n`;
    }

    exportData(options = {}) {
        return exportProfile(this, options);
    }

    importData(payload, options = {}) {
        return importProfile(this, payload, options);
    }
}
