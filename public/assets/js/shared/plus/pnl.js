// Profit and loss analytics for DollarBaan Plus.
//
// Two ways to look at the same filtered set of transactions:
//   mode "all":    since each asset was first registered, at the prices it was bought for, until `to`
//   mode "period": from a chosen date up to `to` (today by default): how the holdings grew or shrank,
//                  counting purchases, sales and withdrawals made in between as money moved, not as gain
// Filters (assets, categories, storage locations) simply narrow the transactions before any math.
import * as ledger from '../ledger.js';
import { CASH_SYMBOL } from '../catalog.js';
import { tehranDate, addDays, isIsoDate } from '../dates.js';
import { badRequest } from '../errors.js';
import { NO_LOCATION_LABEL } from './locations.js';

const NONE = '__none__';
const TIMELINE_POINTS = 120;
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

function list(value) {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

const blank = { quantity: 0, cost: 0, value: 0, realized: 0, withdrawn: 0, bought: 0, price: null };
const totalOf = (snap) => snap.value - snap.cost + snap.realized + snap.withdrawn;

export class PnlCore {
    /**
     * @param {object} options
     * @param {object} options.market       MarketCore
     * @param {object} options.portfolio    PlusPortfolioCore
     * @param {object} options.withdrawals  WithdrawalCore
     */
    constructor({ market, portfolio, withdrawals }) {
        this.market = market;
        this.portfolio = portfolio;
        this.withdrawals = withdrawals;
    }

    parseQuery(query = {}) {
        const today = tehranDate();
        const mode = query.mode === 'period' ? 'period' : 'all';
        let to = query.to ? String(query.to) : today;
        if (!isIsoDate(to)) throw badRequest('تاریخ پایان معتبر نیست');
        if (to > today) to = today;
        let from = query.from ? String(query.from) : null;
        if (from && !isIsoDate(from)) throw badRequest('تاریخ شروع معتبر نیست');
        if (mode === 'period') {
            if (!from) throw badRequest('تاریخ شروع بازه را مشخص کنید');
            if (from > to) throw badRequest('تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد');
        }
        return { mode, from, to, today, symbols: list(query.symbols), categories: list(query.categories), locations: list(query.locations) };
    }

    async compute(query = {}) {
        const q = this.parseQuery(query);
        const all = (await this.portfolio.allTransactions()).filter((tx) => tx.symbol !== CASH_SYMBOL);
        const info = new Map();
        const infoOf = (symbol) => {
            if (!info.has(symbol)) {
                const view = this.market.view(this.market.getAsset(symbol));
                info.set(symbol, { name: view ? view.name : symbol, category: view ? view.category : 'custom', unit: view ? view.unit : null, kind: view ? view.kind : null });
            }
            return info.get(symbol);
        };

        const options = this.filterOptions(all, infoOf);
        const wantedSymbols = new Set(q.symbols);
        const wantedCategories = new Set(q.categories);
        const wantedLocations = new Set(q.locations);
        const included = all.filter((tx) => (!wantedSymbols.size || wantedSymbols.has(tx.symbol))
            && (!wantedCategories.size || wantedCategories.has(infoOf(tx.symbol).category))
            && (!wantedLocations.size || wantedLocations.has(tx.location || NONE)));
        const filtered = Boolean(wantedSymbols.size || wantedCategories.size || wantedLocations.size);

        const first = included.reduce((min, tx) => (!min || tx.date < min ? tx.date : min), null);
        if (!first) return { query: this.echo(q), empty: true, options, transactionCount: 0 };
        const startDate = q.mode === 'all' ? addDays(first, -1) : q.from;
        const shownFrom = q.mode === 'all' ? first : q.from;
        if (q.mode === 'all' && first > q.to) return { query: this.echo(q), empty: true, options, transactionCount: 0 };

        const symbols = [...new Set(included.map((tx) => tx.symbol))];
        const quotes = this.portfolio.quotesFor(symbols);
        const series = new Map();
        for (const symbol of symbols) series.set(symbol, await this.market.seriesFor(symbol));
        const priceOn = (symbol, date, state) => {
            if (date >= q.today) {
                const quote = quotes.get(symbol);
                if (quote && quote.price > 0) return quote.price;
            }
            const point = ledger.closeAsOf(series.get(symbol) || [], date);
            if (point && (!state.lastDate || point.date >= state.lastDate)) return point.close;
            return state.lastPrice;
        };
        const snapshot = (txs, date) => {
            const out = new Map();
            for (const [symbol, state] of ledger.replay(txs.filter((tx) => tx.date <= date))) {
                const price = state.quantity > 0 ? priceOn(symbol, date, state) : null;
                out.set(symbol, {
                    quantity: state.quantity,
                    cost: state.cost,
                    value: price > 0 ? state.quantity * price : 0,
                    realized: state.realized,
                    withdrawn: state.withdrawn,
                    bought: state.bought,
                    price,
                });
            }
            return out;
        };

        const bySymbol = new Map();
        for (const tx of included) {
            if (!bySymbol.has(tx.symbol)) bySymbol.set(tx.symbol, []);
            bySymbol.get(tx.symbol).push(tx);
        }
        const inflowOf = (txs) => txs
            .filter((tx) => tx.side === 'buy' && tx.date > startDate && tx.date <= q.to)
            .reduce((sum, tx) => sum + tx.quantity * tx.unitPrice + tx.fee, 0);

        const rows = [];
        for (const [symbol, txs] of bySymbol) {
            const before = snapshot(txs, startDate).get(symbol) || blank;
            const after = snapshot(txs, q.to).get(symbol) || blank;
            if (after.bought === 0 && before.bought === 0) continue;
            rows.push(this.row(symbol, infoOf(symbol), before, after, inflowOf(txs)));
        }
        rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || Math.abs(b.total) - Math.abs(a.total));

        const summary = this.summarize(rows);
        const period = this.periodSummary(rows);

        const byCategory = this.group(rows, (row) => row.category, (key) => key);
        const byLocation = this.locationRows(included, snapshot, startDate, q.to, inflowOf);

        const points = ledger.buildTimeline({
            transactions: included,
            seriesBySymbol: series,
            currentPrices: new Map([...quotes].map(([symbol, quote]) => [symbol, quote.price])),
            dates: ledger.sampleDates(startDate, q.to, TIMELINE_POINTS),
            today: q.today,
        });
        const baseProfit = points.length ? points[0].value - points[0].invested + points[0].realized + points[0].withdrawn : 0;
        const timeline = points.map((point) => {
            const profit = point.value - point.invested + point.realized + point.withdrawn;
            return {
                date: point.date,
                value: point.value,
                cost: point.invested,
                unrealized: point.value - point.invested,
                realized: point.realized,
                withdrawn: point.withdrawn,
                profit,
                delta: profit - baseProfit,
            };
        });

        const realizedItems = this.realizedHistory(included, infoOf, q.mode === 'period' ? q.from : null, q.to);
        const withdrawals = await this.withdrawalSummary({ q, included, filtered, symbolSet: new Set(symbols), infoOf, wantedCategories });
        summary.withdrawnTotal = withdrawals.lifetime;
        summary.remainingProfit = summary.totalProfit - withdrawals.lifetime;

        return {
            query: this.echo(q),
            empty: false,
            from: shownFrom,
            to: q.to,
            transactionCount: included.length,
            filtered,
            summary,
            period,
            byAsset: rows,
            byCategory,
            byLocation,
            timeline,
            realized: { items: realizedItems, total: realizedItems.reduce((sum, item) => sum + item.realized, 0) },
            withdrawals: { items: withdrawals.items, totals: withdrawals.totals },
            options,
        };
    }

    echo(q) {
        return { mode: q.mode, from: q.from, to: q.to, symbols: q.symbols, categories: q.categories, locations: q.locations };
    }

    filterOptions(all, infoOf) {
        const symbols = new Map();
        const locations = new Map();
        for (const tx of all) {
            if (!symbols.has(tx.symbol)) symbols.set(tx.symbol, { symbol: tx.symbol, ...infoOf(tx.symbol) });
            const key = tx.location || NONE;
            locations.set(key, (locations.get(key) || 0) + 1);
        }
        const list = [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        return {
            symbols: list,
            categories: [...new Set(list.map((item) => item.category))],
            locations: [...locations.entries()].map(([key, count]) => ({ key, name: key === NONE ? NO_LOCATION_LABEL : key, count }))
                .sort((a, b) => b.count - a.count),
        };
    }

    row(symbol, meta, before, after, inflow) {
        const unrealized = after.value - after.cost;
        const total = unrealized + after.realized + after.withdrawn;
        const periodPnl = totalOf(after) - totalOf(before);
        const base = before.value + inflow;
        return {
            symbol,
            name: meta.name,
            category: meta.category,
            unit: meta.unit,
            quantity: after.quantity,
            price: after.price,
            cost: after.cost,
            value: after.value,
            unrealized,
            unrealizedPct: pct(unrealized, after.cost),
            realized: after.realized,
            withdrawn: after.withdrawn,
            invested: after.bought,
            total,
            totalPct: pct(total, after.bought),
            period: {
                startValue: before.value,
                endValue: after.value,
                inflow,
                pnl: periodPnl,
                pct: pct(periodPnl, base),
            },
        };
    }

    summarize(rows) {
        const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
        const value = sum('value');
        const cost = sum('cost');
        const unrealized = value - cost;
        const realized = sum('realized');
        const withdrawnAssets = sum('withdrawn');
        const invested = sum('invested');
        const totalProfit = unrealized + realized + withdrawnAssets;
        return {
            value,
            cost,
            unrealized,
            unrealizedPct: pct(unrealized, cost),
            realized,
            withdrawnAssets,
            invested,
            totalProfit,
            totalProfitPct: pct(totalProfit, invested),
        };
    }

    periodSummary(rows) {
        const startValue = rows.reduce((sum, row) => sum + row.period.startValue, 0);
        const endValue = rows.reduce((sum, row) => sum + row.period.endValue, 0);
        const inflow = rows.reduce((sum, row) => sum + row.period.inflow, 0);
        const pnl = rows.reduce((sum, row) => sum + row.period.pnl, 0);
        return { startValue, endValue, inflow, pnl, pct: pct(pnl, startValue + inflow) };
    }

    group(rows, keyOf, labelOf) {
        const groups = new Map();
        for (const row of rows) {
            const key = keyOf(row);
            const group = groups.get(key) || { key, label: labelOf(key), value: 0, cost: 0, unrealized: 0, realized: 0, withdrawn: 0, total: 0, invested: 0, periodPnl: 0, periodBase: 0 };
            group.value += row.value;
            group.cost += row.cost;
            group.unrealized += row.unrealized;
            group.realized += row.realized;
            group.withdrawn += row.withdrawn;
            group.total += row.total;
            group.invested += row.invested;
            group.periodPnl += row.period.pnl;
            group.periodBase += row.period.startValue + row.period.inflow;
            groups.set(key, group);
        }
        return [...groups.values()]
            .map((group) => ({ ...group, totalPct: pct(group.total, group.invested), periodPct: pct(group.periodPnl, group.periodBase) }))
            .sort((a, b) => b.value - a.value);
    }

    /** Each storage location replayed on its own (a sale at a place reduces what that place holds). */
    locationRows(included, snapshot, startDate, to, inflowOf) {
        const groups = new Map();
        for (const tx of included) {
            const key = tx.location || NONE;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(tx);
        }
        const out = [];
        for (const [key, txs] of groups) {
            const before = snapshot(txs, startDate);
            const after = snapshot(txs, to);
            let value = 0;
            let cost = 0;
            let realized = 0;
            let withdrawn = 0;
            let invested = 0;
            let periodPnl = 0;
            let startValue = 0;
            for (const [symbol, snap] of after) {
                const prev = before.get(symbol) || blank;
                value += snap.value;
                cost += snap.cost;
                realized += snap.realized;
                withdrawn += snap.withdrawn;
                invested += snap.bought;
                periodPnl += totalOf(snap) - totalOf(prev);
                startValue += prev.value;
            }
            const total = value - cost + realized + withdrawn;
            out.push({
                key,
                label: key === NONE ? NO_LOCATION_LABEL : key,
                value,
                cost,
                unrealized: value - cost,
                realized,
                withdrawn,
                total,
                invested,
                totalPct: pct(total, invested),
                periodPnl,
                periodPct: pct(periodPnl, startValue + inflowOf(txs)),
            });
        }
        return out.sort((a, b) => b.value - a.value);
    }

    /** Profit made by each sale (average-cost method), newest first. */
    realizedHistory(included, infoOf, from, to) {
        const bySymbol = new Map();
        for (const tx of included) {
            if (!bySymbol.has(tx.symbol)) bySymbol.set(tx.symbol, []);
            bySymbol.get(tx.symbol).push(tx);
        }
        const items = [];
        for (const [symbol, txs] of bySymbol) {
            const state = ledger.emptyState();
            for (const tx of ledger.sortTransactions(txs)) {
                const before = state.realized;
                const costBefore = state.cost;
                const quantityBefore = state.quantity;
                ledger.apply(state, tx);
                if (tx.side !== 'sell' || tx.kind === 'withdrawal') continue;
                if (tx.date > to || (from && tx.date <= from)) continue;
                const sold = Math.min(tx.quantity, quantityBefore);
                items.push({
                    id: tx.id,
                    date: tx.date,
                    symbol,
                    name: infoOf(symbol).name,
                    quantity: tx.quantity,
                    unitPrice: tx.unitPrice,
                    proceeds: sold * tx.unitPrice - tx.fee,
                    costRemoved: quantityBefore > 0 ? (costBefore / quantityBefore) * sold : 0,
                    realized: state.realized - before,
                    location: tx.location || '',
                });
            }
        }
        return items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    }

    /**
     * Withdrawal records for the report. Their asset parts follow the filters; the cash part belongs to
     * no asset, so it is shown only when nothing is filtered.
     */
    async withdrawalSummary({ q, included, filtered, symbolSet, infoOf, wantedCategories }) {
        const { items } = await this.withdrawals.list();
        const keep = (part) => (part.type === 'cash' ? !filtered : symbolSet.has(part.symbol)
            && (!wantedCategories.size || wantedCategories.has(infoOf(part.symbol).category)));
        const prepared = items
            .map((item) => {
                const allocations = item.allocations.filter(keep);
                return { ...item, allocations, shownAmount: allocations.reduce((sum, part) => sum + part.amount, 0) };
            })
            .filter((item) => item.allocations.length && item.date <= q.to);
        const inRange = prepared.filter((item) => q.mode === 'all' || (item.date > q.from));
        const sumParts = (list, type) => list.reduce((sum, item) => sum + item.allocations.filter((part) => part.type === type).reduce((s, part) => s + part.amount, 0), 0);
        return {
            items: inRange,
            lifetime: prepared.reduce((sum, item) => sum + item.shownAmount, 0),
            totals: {
                count: inRange.length,
                amount: inRange.reduce((sum, item) => sum + item.shownAmount, 0),
                fromAssets: sumParts(inRange, 'asset'),
                fromCash: sumParts(inRange, 'cash'),
                toCash: inRange.filter((item) => item.destination === 'cash').reduce((sum, item) => sum + item.shownAmount, 0),
                external: inRange.filter((item) => item.destination !== 'cash').reduce((sum, item) => sum + item.shownAmount, 0),
            },
        };
    }
}
