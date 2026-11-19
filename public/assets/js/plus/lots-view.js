// What a holding is made of: where it is kept, and every time it was added or reduced.
import { html, icon } from '../lib/dom.js';
import { money, compactMoney, quantity as formatQuantity, unitLabel, jalaliDate, number, percent, trend } from '../format.js';
import { deltaText } from '../ui/asset-visuals.js';

const NO_LOCATION = 'بدون محل نگهداری';

function kindLabel(lot, isCash) {
    if (lot.kind === 'withdrawal') return html`<span class="badge">برداشت سود</span>`;
    if (lot.side === 'buy') return html`<span class="badge buy">${isCash ? 'افزودن' : 'خرید'}</span>`;
    return html`<span class="badge sell">${isCash ? 'کاهش' : 'فروش'}</span>`;
}

function locationsTable(locations, unit, isCash) {
    // A single unnamed location says nothing new.
    if (!locations.length || (locations.length === 1 && !locations[0].location)) return '';
    return html`
        <div class="lots-block">
            <h3>${icon('map-pin', 'icon-sm')}محل نگهداری</h3>
            <div class="table-wrap"><table class="table lots-table">
                <thead><tr><th>محل</th><th class="end">مقدار</th>${isCash ? '' : html`<th class="end">میانگین خرید</th>`}<th class="end">ارزش</th>${isCash ? '' : html`<th class="end">سود و زیان</th>`}<th>سهم</th></tr></thead>
                <tbody>${locations.map((row) => html`
                    <tr>
                        <td class="strong">${row.location || NO_LOCATION}</td>
                        <td class="end">${isCash ? money(row.quantity, { unit: false }) : html`${formatQuantity(row.quantity)}<span class="cell-sub">${unit}</span>`}</td>
                        ${isCash ? '' : html`<td class="end">${money(row.avgCost, { unit: false })}</td>`}
                        <td class="end strong">${money(row.value, { unit: false })}</td>
                        ${isCash ? '' : html`<td class="end"><span class="${trend(row.unrealized)}">${money(row.unrealized, { unit: false, sign: true })}</span><span class="cell-sub">${deltaText(row.unrealizedPct)}</span></td>`}
                        <td><div class="weight-cell"><span>${percent(row.share, { sign: false, digits: 1 })}</span>
                            <div class="meter"><span style="width:${Math.min(100, row.share || 0).toFixed(2)}%"></span></div></div></td>
                    </tr>`)}</tbody>
            </table></div>
        </div>`;
}

function lotsTable(lots, unit, isCash) {
    return html`
        <div class="lots-block">
            <h3>${icon('history', 'icon-sm')}دفعات ثبت <span class="muted small">(${number(lots.length)} مورد، تازه‌ترین بالا)</span></h3>
            <div class="table-wrap"><table class="table lots-table">
                <thead><tr>
                    <th>تاریخ</th><th>نوع</th><th class="end">${isCash ? 'مبلغ' : 'مقدار'}</th>${isCash ? '' : html`<th class="end">قیمت واحد</th><th class="end">مبلغ کل</th>`}
                    <th>محل</th>${isCash ? '' : html`<th class="end">باقی‌مانده</th><th class="end">سود و زیان باقی‌مانده</th>`}<th class="end"><span class="sr-only">عملیات</span></th>
                </tr></thead>
                <tbody>${lots.map((lot) => html`
                    <tr class="${lot.side === 'buy' && lot.remaining === 0 ? 'is-spent' : ''}">
                        <td>${jalaliDate(lot.date)}</td>
                        <td>${kindLabel(lot, isCash)}</td>
                        <td class="end">${isCash ? money(lot.quantity, { unit: false }) : html`${formatQuantity(lot.quantity)}<span class="cell-sub">${unit}</span>`}</td>
                        ${isCash ? '' : html`<td class="end">${money(lot.unitPrice, { unit: false })}</td><td class="end strong">${money(lot.total, { unit: false })}${lot.fee ? html`<span class="cell-sub">کارمزد ${money(lot.fee, { unit: false })}</span>` : ''}</td>`}
                        <td>${lot.location || '—'}</td>
                        ${isCash ? '' : lot.side === 'buy'
                            ? html`<td class="end">${lot.remaining > 0 ? html`${formatQuantity(lot.remaining)}<span class="cell-sub">${unit}</span>` : html`<span class="muted">فروخته‌شده</span>`}</td>
                                <td class="end">${lot.profit === null || lot.remaining === 0 ? '—' : html`<span class="${trend(lot.profit)}">${compactMoney(lot.profit, { sign: true })}</span><span class="cell-sub">${deltaText(lot.profitPct)}</span>`}</td>`
                            : html`<td class="end muted">—</td><td class="end muted">—</td>`}
                        <td class="end">${lot.withdrawalId ? html`<a class="icon-btn plain icon-btn-sm" href="#/pnl?tab=withdrawals" aria-label="دیدن برداشت سود" title="دیدن برداشت سود">${icon('arrow-up-right', 'icon-sm')}</a>`
                            : html`<button type="button" class="icon-btn plain icon-btn-sm" data-edit-lot="${lot.id}" aria-label="ویرایش" title="ویرایش">${icon('pencil', 'icon-sm')}</button>`}</td>
                    </tr>`)}</tbody>
            </table></div>
            ${isCash ? '' : html`<p class="field-hint">باقی‌مانده و سود هر دفعه به روش «اولین ورودی، اولین خروجی» نشان داده می‌شود؛ سود کل دارایی بالا بر پایهٔ میانگین قیمت خرید است.</p>`}
        </div>`;
}

/**
 * @param {{ asset: object, lots: object[], locations: object[] }} detail
 */
export function lotsView({ asset, lots, locations, isCash = false }) {
    const unit = unitLabel(asset && asset.unit);
    if (!lots.length) return html`<div class="empty"><p>هنوز تراکنشی برای این دارایی ثبت نشده است.</p></div>`;
    return html`<div class="lots">${locationsTable(locations, unit, isCash)}${lotsTable(lots, unit, isCash)}</div>`;
}
