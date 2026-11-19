import { api } from '../api.js';
import { store } from '../state.js';
import { html, icon, setHtml } from '../lib/dom.js';
import {
    money, compactMoney, percent, quantity, unitLabel, jalaliDate, searchKey, CATEGORY_LABELS, trend, number,
} from '../format.js';
import { avatar, assetCell, assetSub, deltaText } from '../ui/asset-visuals.js';
import { openTransactionForm } from '../ui/transaction-form.js';
import { openCashForm, CASH_SYMBOL } from '../plus/cash-forms.js';
import { lotsView } from '../plus/lots-view.js';

const SORTS = [
    ['value', 'بیشترین ارزش'],
    ['pnl', 'بیشترین سود'],
    ['pnlPct', 'بیشترین بازده'],
    ['day', 'تغییر امروز'],
    ['name', 'نام'],
];

function sortRows(rows, sort) {
    const list = [...rows];
    const by = {
        value: (a, b) => b.value - a.value,
        pnl: (a, b) => b.unrealized - a.unrealized,
        pnlPct: (a, b) => (b.unrealizedPct ?? -Infinity) - (a.unrealizedPct ?? -Infinity),
        day: (a, b) => (b.dayChangePct ?? -Infinity) - (a.dayChangePct ?? -Infinity),
        name: (a, b) => a.name.localeCompare(b.name, 'fa'),
    }[sort];
    return list.sort(by);
}

const isCash = (row) => row.symbol === CASH_SYMBOL;

/** Cash is an amount; everything else is a quantity of something. */
function quantityCell(row) {
    if (isCash(row)) return html`${money(row.quantity, { unit: false })}`;
    return html`${quantity(row.quantity)}<span class="cell-sub">${unitLabel(row.unit)}</span>`;
}

function placesText(row) {
    const named = (row.locations || []).filter((item) => item.location);
    if (!named.length) return '';
    return named.length === 1 ? named[0].location : `${number(named.length)} محل`;
}

function summary(totals) {
    return html`
        <div class="summary-strip">
            <div><span class="label">ارزش روز</span><span class="value">${money(totals.value)}</span></div>
            <div><span class="label">بهای تمام‌شده</span><span class="value">${money(totals.cost)}</span></div>
            <div><span class="label">سود و زیان باز</span>
                <span class="value ${trend(totals.unrealized)}">${compactMoney(totals.unrealized, { sign: true, unit: true })}</span></div>
            <div><span class="label">سود محقق‌شده</span>
                <span class="value ${trend(totals.realized)}">${compactMoney(totals.realized, { sign: true, unit: true })}</span></div>
        </div>`;
}

function table(rows, expanded) {
    return html`
        <div class="card desktop-table">
            <div class="table-wrap">
                <table class="table holdings-table">
                    <thead>
                        <tr>
                            <th>دارایی</th>
                            <th class="end">مقدار</th>
                            <th class="end">میانگین خرید</th>
                            <th class="end">قیمت روز</th>
                            <th class="end">ارزش</th>
                            <th class="end">سود و زیان</th>
                            <th>سهم از سبد</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((row) => html`
                            <tr class="clickable holding-row" data-symbol="${row.symbol}" tabindex="0" aria-expanded="${expanded.has(row.symbol)}">
                                <td>
                                    <div class="holding-name">
                                        <span class="expander">${icon('chevron-down', 'icon-sm')}</span>
                                        ${assetCell(row, { sub: [assetSub(row), row.lotCount > 1 ? `${number(row.lotCount)} ثبت` : '', placesText(row)].filter(Boolean).join(' · ') })}
                                    </div>
                                </td>
                                <td class="end">${quantityCell(row)}</td>
                                <td class="end">${isCash(row) ? '—' : money(row.avgCost, { unit: false })}</td>
                                <td class="end">${isCash(row) ? '—' : html`${money(row.price, { unit: false })}<span class="cell-sub">${deltaText(row.dayChangePct)}</span>`}</td>
                                <td class="end strong">${money(row.value, { unit: false })}</td>
                                <td class="end">
                                    ${isCash(row) ? '—' : html`<span class="${trend(row.unrealized)}">${money(row.unrealized, { unit: false, sign: true })}</span>
                                    <span class="cell-sub">${deltaText(row.unrealizedPct)}</span>`}
                                </td>
                                <td>
                                    <div class="weight-cell">
                                        <span>${percent(row.weight, { sign: false, digits: 1 })}</span>
                                        <div class="meter"><span style="width:${Math.min(100, row.weight).toFixed(2)}%"></span></div>
                                    </div>
                                </td>
                            </tr>
                            <tr class="lots-row" data-lots-row="${row.symbol}" ${expanded.has(row.symbol) ? '' : html`hidden`}>
                                <td colspan="7"><div class="lots-host" data-lots-host="${row.symbol}"></div></td>
                            </tr>`)}
                    </tbody>
                </table>
            </div>
        </div>`;
}

function cards(rows, expanded) {
    return html`
        <div class="card mobile-cards">
            <div class="list">
                ${rows.map((row) => html`
                    <div class="holding-item">
                        <button type="button" class="list-row holding-toggle" data-toggle="${row.symbol}" aria-expanded="${expanded.has(row.symbol)}">
                            ${avatar(row)}
                            <div class="grow">
                                <span class="title">${row.name}</span>
                                <span class="meta">${isCash(row) ? 'پول نقد' : `${quantity(row.quantity)} ${unitLabel(row.unit)} · میانگین ${compactMoney(row.avgCost)}`}${placesText(row) ? ` · ${placesText(row)}` : ''}</span>
                            </div>
                            <div class="end">
                                <span class="value">${compactMoney(row.value)}</span>
                                <span class="sub">${isCash(row) ? '' : deltaText(row.unrealizedPct)}</span>
                            </div>
                            <span class="expander">${icon('chevron-down', 'icon-sm')}</span>
                        </button>
                        <div class="lots-host" data-lots-host="${row.symbol}" ${expanded.has(row.symbol) ? '' : html`hidden`}></div>
                    </div>`)}
            </div>
        </div>`;
}

function closedTable(rows) {
    if (!rows.length) return html`<div class="card"><div class="empty"><p>هنوز دارایی‌ای را به‌طور کامل نفروخته‌اید.</p></div></div>`;
    return html`
        <div class="card">
            <div class="list">
                ${rows.map((row) => html`
                    <a class="list-row" href="#/asset/${row.symbol}">
                        ${avatar(row, 'sm')}
                        <div class="grow">
                            <span class="title">${row.name}</span>
                            <span class="meta">آخرین معامله ${jalaliDate(row.lastDate)} · ${number(row.count)} تراکنش</span>
                        </div>
                        <div class="end">
                            <span class="value ${trend(row.realized)}">${compactMoney(row.realized, { sign: true, unit: true })}</span>
                            <span class="sub">${deltaText(row.pnlPct)}</span>
                        </div>
                    </a>`)}
            </div>
        </div>`;
}

export function mount({ view, setTitle }) {
    setTitle('دارایی‌های من');
    let alive = true;
    let portfolio = null;
    const filters = { query: '', category: 'all', sort: 'value', closed: false };
    const expanded = new Set();
    const lotsCache = new Map();

    setHtml(view, html`<div class="card card-pad"><span class="skeleton" style="height:240px"></span></div>`);

    function filtered() {
        const tokens = searchKey(filters.query).split(' ').filter(Boolean);
        return sortRows(portfolio.holdings.filter((row) => {
            if (filters.category !== 'all' && row.category !== filters.category) return false;
            if (!tokens.length) return true;
            const key = searchKey(`${row.name} ${row.symbol.replace(/_/g, ' ')}`);
            return tokens.every((token) => key.includes(token));
        }), filters.sort);
    }

    /** Fills the expanded panel of a holding (both the table and the phone layout) with its lots. */
    async function showLots(symbol, { refresh = false } = {}) {
        const hosts = [...view.querySelectorAll(`[data-lots-host="${CSS.escape(symbol)}"]`)];
        if (!hosts.length) return;
        if (!lotsCache.has(symbol) || refresh) {
            for (const host of hosts) setHtml(host, html`<span class="skeleton" style="height:90px"></span>`);
            try {
                lotsCache.set(symbol, await api.get(`/api/portfolio/lots?symbol=${encodeURIComponent(symbol)}`));
            } catch (error) {
                for (const host of hosts) setHtml(host, html`<div class="alert error">${icon('circle-alert')}<div class="grow">${error.message}</div></div>`);
                return;
            }
        }
        if (!alive) return;
        const row = portfolio.holdings.find((item) => item.symbol === symbol);
        const body = html`
            ${lotsView({ asset: row, ...lotsCache.get(symbol), isCash: symbol === CASH_SYMBOL })}
            <div class="lots-actions">
                ${symbol === CASH_SYMBOL
                    ? html`<button type="button" class="btn btn-secondary btn-sm" data-cash-add>${icon('plus', 'icon-sm')}<span>افزودن وجه</span></button>
                        <a class="btn btn-ghost btn-sm" href="#/cash">${icon('banknote', 'icon-sm')}<span>گزارش پول نقد</span></a>`
                    : html`<button type="button" class="btn btn-secondary btn-sm" data-trade="buy" data-symbol-for="${symbol}">${icon('arrow-down-left', 'icon-sm')}<span>ثبت خرید</span></button>
                        <button type="button" class="btn btn-secondary btn-sm" data-trade="sell" data-symbol-for="${symbol}">${icon('arrow-up-right', 'icon-sm')}<span>ثبت فروش</span></button>
                        <a class="btn btn-ghost btn-sm" href="#/asset/${symbol}">${icon('chart-line', 'icon-sm')}<span>نمودار و جزئیات</span></a>`}
            </div>`;
        for (const host of hosts) setHtml(host, body);
    }

    function setExpanded(symbol, open) {
        if (open) expanded.add(symbol);
        else expanded.delete(symbol);
        for (const element of view.querySelectorAll(`[data-symbol="${CSS.escape(symbol)}"], [data-toggle="${CSS.escape(symbol)}"]`)) {
            element.setAttribute('aria-expanded', String(open));
        }
        const tableRow = view.querySelector(`[data-lots-row="${CSS.escape(symbol)}"]`);
        if (tableRow) tableRow.hidden = !open;
        const cardHost = view.querySelector(`.holding-item [data-lots-host="${CSS.escape(symbol)}"]`);
        if (cardHost) cardHost.hidden = !open;
        if (open) showLots(symbol);
    }

    function renderResults() {
        const target = view.querySelector('[data-results]');
        if (!target) return;
        const rows = filtered();
        setHtml(target, html`
            ${rows.length ? html`${table(rows, expanded)}${cards(rows, expanded)}` : html`<div class="card"><div class="empty"><p>دارایی‌ای با این فیلترها پیدا نشد.</p></div></div>`}
            ${filters.closed ? html`<div class="section-title"><h2>دارایی‌های فروخته‌شده</h2></div>${closedTable(portfolio.closed)}` : ''}`);
        for (const symbol of expanded) showLots(symbol);
    }

    function render() {
        if (!portfolio.holdings.length && !portfolio.closed.length) {
            setHtml(view, html`
                <div class="card">
                    <div class="empty" style="padding:56px 24px">
                        <span class="empty-icon">${icon('wallet')}</span>
                        <h3>هنوز دارایی‌ای ثبت نکرده‌اید</h3>
                        <p>با ثبت اولین خرید یا افزودن پول نقد، دارایی‌های شما همراه با ارزش روز، میانگین خرید و سود و زیان اینجا نمایش داده می‌شوند.</p>
                        <div class="actions">
                            <button type="button" class="btn btn-primary" data-add>${icon('plus')}<span>ثبت خرید</span></button>
                            <button type="button" class="btn btn-secondary" data-cash-add>${icon('banknote')}<span>افزودن پول نقد</span></button>
                        </div>
                    </div>
                </div>`);
            return;
        }
        const present = new Set(portfolio.holdings.map((row) => row.category));
        const categories = store.categories.filter((key) => present.has(key));
        setHtml(view, html`
            ${summary(portfolio.totals)}
            <div class="toolbar">
                <label class="search-input">${icon('search')}
                    <input class="input" type="search" placeholder="جستجو در دارایی‌ها…" aria-label="جستجو در دارایی‌ها" value="${filters.query}" data-query>
                </label>
                <div class="chips" role="group" aria-label="دسته‌بندی">
                    <button type="button" class="chip" data-category="all" aria-pressed="${filters.category === 'all'}">همه <span class="count">${number(portfolio.holdings.length)}</span></button>
                    ${categories.map((key) => html`<button type="button" class="chip" data-category="${key}" aria-pressed="${filters.category === key}">${CATEGORY_LABELS[key]}</button>`)}
                </div>
                <span class="spacer"></span>
                <select class="select" style="width:auto;min-height:40px" aria-label="مرتب‌سازی" data-sort>
                    ${SORTS.map(([key, label]) => html`<option value="${key}" ${key === filters.sort ? html`selected` : ''}>${label}</option>`)}
                </select>
                <label class="check"><input type="checkbox" data-closed ${filters.closed ? html`checked` : ''}>فروخته‌شده‌ها</label>
                <button type="button" class="btn btn-secondary btn-sm" data-cash-add>${icon('banknote', 'icon-sm')}<span>پول نقد</span></button>
            </div>
            <p class="field-hint" style="margin:-4px 0 12px">روی هر دارایی بزنید تا دفعات ثبت و محل نگهداری آن به تفکیک نمایش داده شود.</p>
            <div data-results></div>`);
        renderResults();
    }

    async function load({ quiet = false } = {}) {
        if (quiet) view.classList.add('is-refreshing');
        try {
            portfolio = await store.loadPortfolio();
            lotsCache.clear();
            if (alive) render();
        } catch (error) {
            if (alive) setHtml(view, html`<div class="alert error">${icon('circle-alert')}<div class="grow">${error.message}</div></div>`);
        } finally {
            view.classList.remove('is-refreshing');
        }
    }

    const onClick = (event) => {
        const chip = event.target.closest('[data-category]');
        if (chip) {
            filters.category = chip.dataset.category;
            for (const element of view.querySelectorAll('[data-category]')) {
                element.setAttribute('aria-pressed', String(element.dataset.category === filters.category));
            }
            renderResults();
            return;
        }
        const trade = event.target.closest('[data-trade]');
        if (trade) {
            openTransactionForm({ symbol: trade.dataset.symbolFor, side: trade.dataset.trade });
            return;
        }
        const editLot = event.target.closest('[data-edit-lot]');
        if (editLot) {
            const host = editLot.closest('[data-lots-host]');
            const detail = host && lotsCache.get(host.dataset.lotsHost);
            const lot = detail && detail.lots.find((item) => item.id === editLot.dataset.editLot);
            if (lot) openTransactionForm({ transaction: { ...lot, symbol: detail.symbol } });
            return;
        }
        if (event.target.closest('[data-cash-add]')) {
            openCashForm({ side: 'buy' });
            return;
        }
        if (event.target.closest('a, [data-lots-host]')) return;
        const toggle = event.target.closest('[data-toggle]');
        if (toggle) {
            setExpanded(toggle.dataset.toggle, !expanded.has(toggle.dataset.toggle));
            return;
        }
        const row = event.target.closest('tr[data-symbol]');
        if (row) {
            setExpanded(row.dataset.symbol, !expanded.has(row.dataset.symbol));
            return;
        }
        if (event.target.closest('[data-add]')) openTransactionForm();
    };
    const onInput = (event) => {
        if (event.target.matches('[data-query]')) {
            filters.query = event.target.value;
            renderResults();
        }
    };
    const onChange = (event) => {
        if (event.target.matches('[data-sort]')) filters.sort = event.target.value;
        if (event.target.matches('[data-closed]')) filters.closed = event.target.checked;
        renderResults();
    };
    const onKey = (event) => {
        const row = event.target.closest('tr[data-symbol]');
        if (row && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            setExpanded(row.dataset.symbol, !expanded.has(row.dataset.symbol));
        }
    };
    view.addEventListener('click', onClick);
    view.addEventListener('input', onInput);
    view.addEventListener('change', onChange);
    view.addEventListener('keydown', onKey);

    const unsubscribe = [
        store.on('data-changed', () => load({ quiet: true })),
        store.on('synced', () => load({ quiet: true })),
        store.on('unit', () => portfolio && render()),
    ];
    load();

    return {
        unmount() {
            alive = false;
            view.removeEventListener('click', onClick);
            view.removeEventListener('input', onInput);
            view.removeEventListener('change', onChange);
            view.removeEventListener('keydown', onKey);
            unsubscribe.forEach((off) => off());
        },
    };
}
