// Per-holding detail for DollarBaan Plus: every time an asset was added (a "lot") and where it is kept.
// Pure functions over one symbol's transactions.
import { replay, sortTransactions, EPSILON } from '../ledger.js';

const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

/**
 * Every transaction of one asset, newest first. Buys carry what is left of them (sales and
 * withdrawals consume the oldest lots first, FIFO), valued at `price`. The asset's own totals
 * use the average-cost method, so lot figures are an illustration of each purchase, not a second
 * source for the holding's profit.
 */
export function buildLots(transactions, price) {
    const queue = [];
    const lots = [];
    for (const tx of sortTransactions(transactions)) {
        const quantity = Number(tx.quantity);
        const unitPrice = Number(tx.unitPrice);
        const row = {
            id: tx.id,
            date: tx.date,
            side: tx.side,
            kind: tx.kind || 'trade',
            quantity,
            unitPrice,
            fee: Number(tx.fee) || 0,
            total: quantity * unitPrice,
            location: tx.location || '',
            note: tx.note || '',
            linkId: tx.linkId || null,
            withdrawalId: tx.withdrawalId || null,
            sourceId: tx.sourceId || null,
        };
        if (tx.side === 'buy') {
            row.remaining = quantity;
            queue.push(row);
        } else {
            let left = quantity;
            for (const lot of queue) {
                if (left <= EPSILON) break;
                const taken = Math.min(lot.remaining, left);
                lot.remaining -= taken;
                left -= taken;
            }
        }
        lots.push(row);
    }
    for (const lot of lots) {
        if (lot.side !== 'buy') continue;
        if (lot.remaining <= EPSILON) lot.remaining = 0;
        const share = lot.quantity > 0 ? lot.remaining / lot.quantity : 0;
        lot.cost = (lot.total + lot.fee) * share;
        lot.value = price > 0 ? lot.remaining * price : null;
        lot.profit = lot.value === null ? null : lot.value - lot.cost;
        lot.profitPct = lot.value === null ? null : pct(lot.profit, lot.cost);
    }
    return lots.reverse();
}

/**
 * Holdings split by storage location. Each location is replayed on its own, so a purchase and a
 * sale recorded at the same place net out there. A sale recorded without a location is taken from
 * the places that hold the asset, largest first, so the parts always add up to what is owned.
 * Locations holding nothing are left out.
 */
export function locationBreakdown(transactions, price) {
    const groups = new Map();
    for (const tx of transactions) {
        const key = tx.location || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tx);
    }

    // Units sold without a location beyond what was bought without one.
    let deficit = 0;
    let unplaced = 0;
    for (const tx of sortTransactions(groups.get('') || [])) {
        if (tx.side === 'buy') {
            unplaced += tx.quantity;
        } else {
            const taken = Math.min(tx.quantity, unplaced);
            unplaced -= taken;
            deficit += tx.quantity - taken;
        }
    }

    const rows = [];
    for (const [location, list] of groups) {
        const state = [...replay(list).values()][0];
        if (!state || state.quantity <= EPSILON) continue;
        rows.push({ location, quantity: state.quantity, cost: state.cost, avgCost: state.cost / state.quantity });
    }
    for (const row of [...rows].filter((item) => item.location).sort((a, b) => b.quantity - a.quantity)) {
        if (deficit <= EPSILON) break;
        const taken = Math.min(row.quantity, deficit);
        row.quantity -= taken;
        row.cost -= row.avgCost * taken;
        deficit -= taken;
    }

    let total = 0;
    const out = rows.filter((row) => row.quantity > EPSILON).map((row) => {
        const value = price > 0 ? row.quantity * price : null;
        total += value || 0;
        return {
            ...row,
            value,
            unrealized: value === null ? null : value - row.cost,
            unrealizedPct: value === null ? null : pct(value - row.cost, row.cost),
        };
    });
    for (const row of out) row.share = total > 0 && row.value !== null ? (row.value / total) * 100 : null;
    return out.sort((a, b) => (b.value || 0) - (a.value || 0));
}
