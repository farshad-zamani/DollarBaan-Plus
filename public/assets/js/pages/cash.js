// Cash (پول نقد): the balance, where each part of it is kept, where it came from, and the full history.
import { api } from '../api.js';
import { store } from '../state.js';
import { html, icon, setHtml } from '../lib/dom.js';
import { money, compactMoney, number, jalaliDate, jalaliLong, todayIso, percent, currencyLabel } from '../format.js';
import { createDatePicker } from '../ui/datepicker.js';
import { notify } from '../ui/toast.js';
import { saveFile } from '../download.js';
import { openCashForm, openSourcesManager, CASH_SYMBOL } from '../plus/cash-forms.js';

const DIRECTIONS = [['', 'همه'], ['in', 'افزوده‌شده'], ['out', 'کم‌شده']];

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function mount({ view, setTitle }) {
    setTitle('پول نقد', jalaliLong(todayIso()));
    let alive = true;
    let data = null;
    const filters = { from: null, to: null, source: '', location: '', direction: '' };
    let fromPicker = null;
    let toPicker = null;

    setHtml(view, html`<div class="card card-pad"><span class="skeleton" style="height:240px"></span></div>`);

    function query() {
        const params = new URLSearchParams();
        if (filters.from) params.set('from', filters.from);
        if (filters.to) params.set('to', filters.to);
        if (filters.source) params.set('source', filters.source);
        if (filters.location) params.set('location', filters.location);
        if (filters.direction) params.set('direction', filters.direction);
        const text = params.toString();
        return `/api/cash/overview${text ? `?${text}` : ''}`;
    }

    function summary() {
        return html`
            <div class="summary-strip">
                <div><span class="label">افزوده‌شده</span><span class="value pos">${compactMoney(data.totals.in, { unit: true })}</span></div>
                <div><span class="label">کم‌شده</span><span class="value neg">${compactMoney(data.totals.out, { unit: true })}</span></div>
                <div><span class="label">خالص در این گزارش</span><span class="value">${compactMoney(data.totals.in - data.totals.out, { sign: true, unit: true })}</span></div>
                <div><span class="label">تعداد ردیف</span><span class="value">${number(data.totals.count)}</span></div>
            </div>`;
    }

    function sourcesCard() {
        const rows = data.bySource;
        const total = rows.reduce((sum, row) => sum + row.total, 0);
        return html`
            <article class="card">
                <div class="card-head"><h2>مجموع به تفکیک منبع</h2><span class="sub">${filters.from || filters.to ? 'در بازهٔ انتخاب‌شده' : 'از ابتدا'}</span></div>
                ${rows.length ? html`
                    <div class="table-wrap"><table class="table">
                        <thead><tr><th>منبع</th><th class="end">تعداد</th><th class="end">مجموع (${currencyLabel()})</th><th>سهم</th><th class="end">آخرین واریز</th></tr></thead>
                        <tbody>${rows.map((row) => html`
                            <tr class="clickable" data-filter-source="${row.sourceId || 'none'}" tabindex="0" title="فقط ردیف‌های این منبع را نشان بده">
                                <td class="strong">${row.name}</td>
                                <td class="end">${number(row.count)}</td>
                                <td class="end strong">${money(row.total, { unit: false })}</td>
                                <td><div class="weight-cell"><span>${percent(total > 0 ? (row.total / total) * 100 : 0, { sign: false, digits: 1 })}</span>
                                    <div class="meter"><span style="width:${Math.min(100, total > 0 ? (row.total / total) * 100 : 0).toFixed(2)}%"></span></div></div></td>
                                <td class="end small muted">${jalaliDate(row.lastDate)}</td>
                            </tr>`)}</tbody>
                    </table></div>` : html`<div class="empty"><p>در این گزارش وجهی اضافه نشده است.</p></div>`}
            </article>`;
    }

    function historyCard() {
        const rows = data.history;
        return html`
            <article class="card">
                <div class="card-head">
                    <h2>تاریخچه</h2>
                    <button type="button" class="btn btn-ghost btn-sm" data-export ${rows.length ? '' : html`disabled`}>${icon('file-spreadsheet', 'icon-sm')}<span>خروجی اکسل</span></button>
                </div>
                ${rows.length ? html`
                    <div class="table-wrap desktop-table"><table class="table">
                        <thead><tr><th>تاریخ</th><th>نوع</th><th class="end">مبلغ (${currencyLabel()})</th><th>منبع یا علت</th><th>محل نگهداری</th><th>یادداشت</th><th class="end"><span class="sr-only">عملیات</span></th></tr></thead>
                        <tbody>${rows.map((row) => html`
                            <tr>
                                <td>${jalaliDate(row.date)}</td>
                                <td>${kindBadge(row)}</td>
                                <td class="end strong ${row.side === 'buy' ? 'pos' : 'neg'}">${row.side === 'buy' ? '+' : '−'}${money(row.amount, { unit: false })}</td>
                                <td>${row.side === 'buy' ? row.sourceName : row.reason || '—'}${row.side === 'buy' && row.reason ? html`<span class="cell-sub">${row.reason}</span>` : ''}</td>
                                <td>${row.location || '—'}</td>
                                <td class="note" title="${row.note}">${row.note || '—'}</td>
                                <td class="end"><button type="button" class="icon-btn plain icon-btn-sm" data-edit="${row.id}" aria-label="ویرایش" title="ویرایش">${icon('pencil', 'icon-sm')}</button></td>
                            </tr>`)}</tbody>
                    </table></div>
                    <div class="list mobile-cards">${rows.map((row) => html`
                        <button type="button" class="list-row" data-edit="${row.id}">
                            <span class="asset-avatar sm cat-cash">${icon(row.side === 'buy' ? 'arrow-down-left' : 'arrow-up-right')}</span>
                            <div class="grow">
                                <span class="title">${row.side === 'buy' ? row.sourceName : row.reason || 'کاهش موجودی'}</span>
                                <span class="meta">${jalaliDate(row.date)}${row.location ? ` · ${row.location}` : ''}${row.note ? ` · ${row.note}` : ''}</span>
                            </div>
                            <div class="end"><span class="value ${row.side === 'buy' ? 'pos' : 'neg'}">${row.side === 'buy' ? '+' : '−'}${compactMoney(row.amount)}</span></div>
                        </button>`)}</div>` : html`<div class="empty"><p>ردیفی با این فیلترها پیدا نشد.</p></div>`}
            </article>`;
    }

    const kindBadge = (row) => (row.withdrawalId
        ? html`<span class="badge">برداشت سود</span>`
        : row.side === 'buy' ? html`<span class="badge buy">افزودن</span>` : html`<span class="badge sell">کاهش</span>`);

    function filterBar() {
        const sources = data.sources;
        return html`
            <div class="card card-pad filter-card">
                <div class="filter-grid">
                    <div class="field"><span class="field-label">از تاریخ</span><div data-from></div></div>
                    <div class="field"><span class="field-label">تا تاریخ</span><div data-to></div></div>
                    <div class="field"><label for="f-source">منبع</label>
                        <select id="f-source" class="select" data-source>
                            <option value="">همه منبع‌ها</option>
                            ${sources.map((source) => html`<option value="${source.id}" ${filters.source === source.id ? html`selected` : ''}>${source.name}</option>`)}
                            <option value="none" ${filters.source === 'none' ? html`selected` : ''}>بدون منبع</option>
                        </select></div>
                    <div class="field"><label for="f-location">محل نگهداری</label>
                        <select id="f-location" class="select" data-location>
                            <option value="">همه محل‌ها</option>
                            ${data.locations.map((item) => html`<option value="${item.location || '__none__'}" ${filters.location === (item.location || '__none__') ? html`selected` : ''}>${item.label}</option>`)}
                        </select></div>
                    <div class="field"><span class="field-label">نوع</span>
                        <div class="segmented block" role="group" aria-label="نوع ردیف" data-direction>
                            ${DIRECTIONS.map(([key, label]) => html`<button type="button" data-value="${key}" aria-pressed="${filters.direction === key}">${label}</button>`)}
                        </div></div>
                </div>
                ${filters.from || filters.to || filters.source || filters.location || filters.direction
                    ? html`<div><button type="button" class="btn btn-ghost btn-sm" data-clear>${icon('x', 'icon-sm')}<span>پاک کردن فیلترها</span></button></div>` : ''}
            </div>`;
    }

    function render() {
        const locations = data.locations;
        setHtml(view, html`
            <div class="dash">
                <section class="kpis cash-kpis" aria-label="موجودی نقد">
                    <article class="card hero cash-hero">
                        <div>
                            <div class="hero-label">${icon('banknote', 'icon-sm')}موجودی پول نقد</div>
                            <div class="hero-value"><span class="amount">${number(Math.round(Math.max(0, data.balance) * (store.preferences.displayUnit === 'rial' ? 10 : 1)))}</span> <span class="unit">${currencyLabel()}</span></div>
                        </div>
                        <div class="hero-meta">
                            ${locations.length ? locations.map((item) => html`<span class="delta-pill">${icon('map-pin', 'icon-sm')}${item.label}: ${compactMoney(item.amount)}</span>`) : html`<span>هنوز وجهی ثبت نشده است</span>`}
                        </div>
                    </article>
                    <article class="card stat cash-actions">
                        <div class="stat-label">${icon('plus')}عملیات</div>
                        <div class="cash-buttons">
                            <button type="button" class="btn btn-primary" data-add>${icon('arrow-down-left')}<span>افزودن وجه</span></button>
                            <button type="button" class="btn btn-secondary" data-spend>${icon('arrow-up-right')}<span>کاهش موجودی</span></button>
                            <button type="button" class="btn btn-ghost" data-sources>${icon('tags')}<span>منبع‌ها</span></button>
                        </div>
                        <div class="stat-foot">پول نقد در ارزش کل دارایی‌ها حساب می‌شود، اما سرمایه‌گذاری به شمار نمی‌آید.</div>
                    </article>
                </section>
                ${filterBar()}
                ${summary()}
                <div class="stack">${sourcesCard()}${historyCard()}</div>
            </div>`);
        fromPicker = createDatePicker(view.querySelector('[data-from]'), { value: filters.from, label: 'از تاریخ', onChange: (iso) => { filters.from = iso; reload(); } });
        toPicker = createDatePicker(view.querySelector('[data-to]'), { value: filters.to, label: 'تا تاریخ', onChange: (iso) => { filters.to = iso; reload(); } });
    }

    async function reload({ quiet = true } = {}) {
        if (quiet) view.classList.add('is-refreshing');
        try {
            data = await api.get(query());
            if (alive) render();
        } catch (error) {
            if (alive) setHtml(view, html`<div class="alert error">${icon('circle-alert')}<div class="grow">${error.message}</div></div>`);
        } finally {
            view.classList.remove('is-refreshing');
        }
    }

    async function exportCsv() {
        const header = ['تاریخ (شمسی)', 'تاریخ (میلادی)', 'نوع', 'مبلغ (تومان)', 'منبع', 'علت', 'محل نگهداری', 'یادداشت'];
        const lines = [header.map(csvCell).join(',')];
        for (const row of data.history) {
            lines.push([jalaliDate(row.date), row.date, row.side === 'buy' ? 'افزودن' : 'کاهش', row.amount, row.sourceName || '', row.reason || '', row.location, row.note].map(csvCell).join(','));
        }
        await saveFile({ filename: `dollarbaanplus-cash-${todayIso()}.csv`, type: 'text/csv; charset=utf-8', body: `﻿${lines.join('\r\n')}\r\n` });
    }

    const onClick = (event) => {
        if (event.target.closest('[data-add]')) {
            openCashForm({ side: 'buy' });
            return;
        }
        if (event.target.closest('[data-spend]')) {
            openCashForm({ side: 'sell' });
            return;
        }
        if (event.target.closest('[data-sources]')) {
            openSourcesManager().then((changed) => changed && reload());
            return;
        }
        const direction = event.target.closest('[data-direction] button');
        if (direction) {
            filters.direction = direction.dataset.value;
            reload();
            return;
        }
        if (event.target.closest('[data-clear]')) {
            Object.assign(filters, { from: null, to: null, source: '', location: '', direction: '' });
            reload();
            return;
        }
        const bySource = event.target.closest('[data-filter-source]');
        if (bySource) {
            filters.source = bySource.dataset.filterSource;
            reload();
            return;
        }
        const edit = event.target.closest('[data-edit]');
        if (edit) {
            const row = data.history.find((item) => item.id === edit.dataset.edit);
            if (row) openCashForm({ transaction: { id: row.id, symbol: CASH_SYMBOL, side: row.side, quantity: row.amount, date: row.date, sourceId: row.sourceId, location: row.location, note: row.note, linkId: row.linkId, withdrawalId: row.withdrawalId } });
            return;
        }
        if (event.target.closest('[data-export]')) exportCsv().catch((error) => notify.error(error.message || 'ساخت فایل ناموفق بود'));
    };
    const onChange = (event) => {
        if (event.target.matches('[data-source]')) {
            filters.source = event.target.value;
            reload();
        } else if (event.target.matches('[data-location]')) {
            filters.location = event.target.value;
            reload();
        }
    };
    const onKey = (event) => {
        const row = event.target.closest('tr[data-filter-source]');
        if (row && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            filters.source = row.dataset.filterSource;
            reload();
        }
    };
    view.addEventListener('click', onClick);
    view.addEventListener('change', onChange);
    view.addEventListener('keydown', onKey);

    const unsubscribe = [
        store.on('data-changed', () => reload()),
        store.on('unit', () => data && render()),
    ];
    reload({ quiet: false });

    return {
        unmount() {
            alive = false;
            view.removeEventListener('click', onClick);
            view.removeEventListener('change', onChange);
            view.removeEventListener('keydown', onKey);
            unsubscribe.forEach((off) => off());
        },
    };
}
