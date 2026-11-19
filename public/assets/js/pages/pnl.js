// Profit and loss: how the holdings have done, since they were bought or over any period,
// filtered by asset, category and storage location; what was withdrawn; and what was realized.
import { api } from '../api.js';
import { store } from '../state.js';
import { html, icon, setHtml } from '../lib/dom.js';
import {
    money, compactMoney, percent, quantity, unitLabel, jalaliDate, jalaliLong, todayIso, number, currencyLabel, trend, CATEGORY_LABELS,
} from '../format.js';
import { addDays } from '../shared/dates.js';
import { lineChart, cssVar } from '../lib/charts.js';
import { deltaText } from '../ui/asset-visuals.js';
import { createDatePicker } from '../ui/datepicker.js';
import { confirmDialog } from '../ui/dialog.js';
import { notify } from '../ui/toast.js';
import { createMultiSelect } from '../plus/multi-select.js';
import { openWithdrawDialog } from '../plus/withdraw-dialog.js';

const TABS = [
    ['overview', 'نمای کلی'],
    ['assets', 'دارایی‌ها'],
    ['history', 'تاریخچهٔ سود و زیان'],
    ['withdrawals', 'برداشت سود'],
    ['realized', 'سود محقق‌شده'],
];
const PRESETS = [['۱ هفته', 7], ['۱ ماه', 30], ['۳ ماه', 91], ['۶ ماه', 182], ['۱ سال', 365]];

const signed = (value) => compactMoney(value, { sign: true });
const amount = (text) => html`${text} <span class="unit">${currencyLabel()}</span>`;
const tone = (value) => trend(value);

function kpi(label, value, foot, { pctValue = null, iconName, valueClass = '' } = {}) {
    return html`
        <article class="card stat">
            <div class="stat-label">${icon(iconName)}${label}</div>
            <div class="stat-value ${valueClass}">${value}</div>
            ${foot || pctValue !== null ? html`<div class="stat-foot">${pctValue !== null ? deltaText(pctValue) : ''} <span>${foot || ''}</span></div>` : ''}
        </article>`;
}

export function mount({ view, setTitle, query }) {
    setTitle('سود و زیان', jalaliLong(todayIso()));
    let alive = true;
    let chart = null;
    let data = null;
    let tab = TABS.some(([key]) => key === (query && query.get('tab'))) ? query.get('tab') : 'overview';
    const filters = { mode: 'all', from: addDays(todayIso(), -30), to: null, symbols: [], categories: [], locations: [] };
    const pickers = [];
    const selects = [];

    setHtml(view, html`<div class="card card-pad"><span class="skeleton" style="height:260px"></span></div>`);

    function params() {
        const search = new URLSearchParams({ mode: filters.mode });
        if (filters.mode === 'period') search.set('from', filters.from);
        if (filters.to) search.set('to', filters.to);
        if (filters.symbols.length) search.set('symbols', filters.symbols.join(','));
        if (filters.categories.length) search.set('categories', filters.categories.join(','));
        if (filters.locations.length) search.set('locations', filters.locations.join(','));
        return search.toString();
    }

    function destroyChart() {
        if (chart) chart.destroy();
        chart = null;
    }

    /* ---------- filter bar ---------- */

    function filterBar(options) {
        const period = filters.mode === 'period';
        return html`
            <div class="card card-pad filter-card">
                <div class="filter-top">
                    <div class="segmented" role="group" aria-label="نوع محاسبه" data-mode>
                        <button type="button" data-value="all" aria-pressed="${!period}">از زمان خرید تا امروز</button>
                        <button type="button" data-value="period" aria-pressed="${period}">بازهٔ تاریخی مشخص</button>
                    </div>
                    <span class="field-hint">${period
                        ? 'رشد یا کاهش دارایی‌ها از تاریخ انتخابی؛ خرید و فروش‌های داخل بازه جابه‌جایی پول حساب می‌شود، نه سود.'
                        : 'سود و زیان بر پایهٔ قیمت خرید هر دارایی، از اولین ثبت تا امروز.'}</span>
                </div>
                ${period ? html`
                    <div class="filter-grid">
                        <div class="field"><span class="field-label">از تاریخ</span><div data-from></div></div>
                        <div class="field"><span class="field-label">تا تاریخ</span><div data-to></div></div>
                        <div class="field wide"><span class="field-label">بازهٔ سریع</span>
                            <div class="chips">${PRESETS.map(([label, days]) => html`<button type="button" class="chip" data-preset="${days}">${label} پیش</button>`)}</div></div>
                    </div>` : ''}
                <div class="filter-grid">
                    <div class="field"><span class="field-label">دارایی</span><div data-symbols></div></div>
                    <div class="field"><span class="field-label">دسته</span><div data-categories></div></div>
                    <div class="field"><span class="field-label">محل نگهداری</span><div data-locations></div></div>
                </div>
                ${filters.symbols.length || filters.categories.length || filters.locations.length
                    ? html`<div><button type="button" class="btn btn-ghost btn-sm" data-clear>${icon('x', 'icon-sm')}<span>پاک کردن فیلترها</span></button></div>` : ''}
            </div>`;
    }

    function mountFilterControls(options) {
        for (const picker of pickers.splice(0)) picker.close();
        for (const select of selects.splice(0)) select.destroy();
        if (filters.mode === 'period') {
            pickers.push(createDatePicker(view.querySelector('[data-from]'), {
                value: filters.from,
                label: 'از تاریخ',
                onChange: (iso) => {
                    filters.from = iso;
                    if (filters.to && filters.to < iso) filters.to = null;
                    reload();
                },
            }));
            pickers.push(createDatePicker(view.querySelector('[data-to]'), {
                value: filters.to || todayIso(),
                label: 'تا تاریخ',
                onChange: (iso) => {
                    filters.to = iso === todayIso() ? null : iso;
                    reload();
                },
            }));
        }
        selects.push(createMultiSelect(view.querySelector('[data-symbols]'), {
            options: options.symbols.map((item) => ({ value: item.symbol, label: item.name, sub: CATEGORY_LABELS[item.category] })),
            selected: filters.symbols,
            allLabel: 'همه دارایی‌ها',
            countLabel: (count) => `${number(count)} دارایی`,
            onChange: (values) => {
                filters.symbols = values;
                reload();
            },
        }));
        selects.push(createMultiSelect(view.querySelector('[data-categories]'), {
            options: options.categories.map((key) => ({ value: key, label: CATEGORY_LABELS[key] || key })),
            selected: filters.categories,
            allLabel: 'همه دسته‌ها',
            countLabel: (count) => `${number(count)} دسته`,
            searchable: false,
            onChange: (values) => {
                filters.categories = values;
                reload();
            },
        }));
        selects.push(createMultiSelect(view.querySelector('[data-locations]'), {
            options: options.locations.map((item) => ({ value: item.key, label: item.name, sub: `${number(item.count)} تراکنش` })),
            selected: filters.locations,
            allLabel: 'همه محل‌ها',
            countLabel: (count) => `${number(count)} محل`,
            searchable: false,
            onChange: (values) => {
                filters.locations = values;
                reload();
            },
        }));
    }

    /* ---------- panels ---------- */

    function kpis() {
        const { summary, period } = data;
        const isPeriod = filters.mode === 'period';
        const cards = [];
        if (isPeriod) {
            cards.push(html`
                <article class="card hero pnl-hero">
                    <div>
                        <div class="hero-label">${icon('calendar-range', 'icon-sm')}تغییر در بازه (${jalaliDate(data.from)} تا ${jalaliDate(data.to)})</div>
                        <div class="hero-value lg"><span class="amount">${compactMoney(period.pnl, { sign: true })}</span> <span class="unit">${currencyLabel()}</span></div>
                    </div>
                    <div class="hero-meta">
                        <span class="delta-pill ${tone(period.pnl)}">${period.pct === null ? '—' : percent(period.pct)}</span>
                        <span>ارزش اول بازه ${compactMoney(period.startValue)} · ارزش پایان ${compactMoney(period.endValue)}</span>
                    </div>
                </article>`);
        } else {
            cards.push(html`
                <article class="card hero pnl-hero">
                    <div>
                        <div class="hero-label">${icon('trending-up', 'icon-sm')}سود و زیان کل (از ${jalaliDate(data.from)})</div>
                        <div class="hero-value lg"><span class="amount">${compactMoney(summary.totalProfit, { sign: true })}</span> <span class="unit">${currencyLabel()}</span></div>
                    </div>
                    <div class="hero-meta">
                        <span class="delta-pill ${tone(summary.totalProfit)}">${summary.totalProfitPct === null ? '—' : percent(summary.totalProfitPct)}</span>
                        <span>از ${compactMoney(summary.invested)} خرید</span>
                    </div>
                </article>`);
        }
        cards.push(kpi('ارزش فعلی', amount(compactMoney(summary.value)), `بهای تمام‌شده ${compactMoney(summary.cost)}`, { iconName: 'wallet' }));
        cards.push(kpi('سود و زیان فعلی (باز)', amount(signed(summary.unrealized)), 'دارایی‌های نگه‌داری‌شده', { pctValue: summary.unrealizedPct, iconName: 'chart-line' }));
        cards.push(kpi('سود محقق‌شده', amount(signed(summary.realized)), 'از فروش‌ها', { iconName: 'hand-coins' }));
        cards.push(kpi('سود برداشت‌شده', amount(compactMoney(summary.withdrawnTotal)), `از دارایی ${compactMoney(summary.withdrawnAssets)} · از نقد ${compactMoney(Math.max(0, summary.withdrawnTotal - summary.withdrawnAssets))}`, { iconName: 'arrow-up-from-line' }));
        cards.push(kpi('سود باقی‌مانده', amount(signed(summary.remainingProfit)), 'سود کل منهای برداشت‌ها', { iconName: 'piggy-bank' }));
        return html`<section class="kpis pnl-kpis" aria-label="خلاصه سود و زیان">${cards}</section>`;
    }

    function breakdown(title, rows, labelOf) {
        if (!rows.length) return '';
        const periodMode = filters.mode === 'period';
        return html`
            <article class="card">
                <div class="card-head"><h2>${title}</h2></div>
                <div class="table-wrap"><table class="table">
                    <thead><tr><th>${title.replace('به تفکیک ', '')}</th><th class="end">ارزش</th><th class="end">سود و زیان کل</th>${periodMode ? html`<th class="end">تغییر در بازه</th>` : ''}</tr></thead>
                    <tbody>${rows.map((row) => html`
                        <tr>
                            <td class="strong">${labelOf(row)}</td>
                            <td class="end">${money(row.value, { unit: false })}</td>
                            <td class="end"><span class="${tone(row.total)}">${money(row.total, { unit: false, sign: true })}</span><span class="cell-sub">${deltaText(row.totalPct)}</span></td>
                            ${periodMode ? html`<td class="end"><span class="${tone(row.periodPnl)}">${money(row.periodPnl, { unit: false, sign: true })}</span><span class="cell-sub">${deltaText(row.periodPct)}</span></td>` : ''}
                        </tr>`)}</tbody>
                </table></div>
            </article>`;
    }

    function overviewPanel() {
        const periodMode = filters.mode === 'period';
        return html`
            <article class="card" data-chart-card>
                <div class="chart-head">
                    <div class="legend">
                        <span class="legend-item"><span class="legend-key value"></span>${periodMode ? 'تغییر نسبت به ابتدای بازه' : 'سود و زیان کل'}</span>
                        <span class="legend-item"><span class="legend-key context"></span>${periodMode ? 'سود و زیان کل' : 'سود و زیان باز'}</span>
                    </div>
                </div>
                <div class="chart-box" data-chart></div>
            </article>
            <div class="pnl-split">
                ${breakdown('به تفکیک دسته', data.byCategory, (row) => CATEGORY_LABELS[row.key] || row.key)}
                ${breakdown('به تفکیک محل نگهداری', data.byLocation, (row) => row.label)}
            </div>`;
    }

    function assetsPanel() {
        const periodMode = filters.mode === 'period';
        return html`
            <article class="card">
                <div class="table-wrap"><table class="table">
                    <thead><tr>
                        <th>دارایی</th><th class="end">مقدار</th><th class="end">بهای تمام‌شده</th><th class="end">ارزش</th>
                        <th class="end">سود و زیان باز</th><th class="end">محقق‌شده</th><th class="end">برداشت‌شده</th><th class="end">سود کل</th>
                        ${periodMode ? html`<th class="end">تغییر در بازه</th>` : ''}
                    </tr></thead>
                    <tbody>${data.byAsset.map((row) => html`
                        <tr class="clickable" data-asset="${row.symbol}" tabindex="0">
                            <td class="strong">${row.name}<span class="cell-sub">${CATEGORY_LABELS[row.category] || ''}</span></td>
                            <td class="end">${row.quantity > 0 ? html`${quantity(row.quantity)}<span class="cell-sub">${unitLabel(row.unit)}</span>` : html`<span class="muted">فروخته‌شده</span>`}</td>
                            <td class="end">${money(row.cost, { unit: false })}</td>
                            <td class="end">${money(row.value, { unit: false })}</td>
                            <td class="end"><span class="${tone(row.unrealized)}">${money(row.unrealized, { unit: false, sign: true })}</span><span class="cell-sub">${row.quantity > 0 ? deltaText(row.unrealizedPct) : ''}</span></td>
                            <td class="end"><span class="${tone(row.realized)}">${money(row.realized, { unit: false, sign: true })}</span></td>
                            <td class="end">${row.withdrawn ? money(row.withdrawn, { unit: false }) : '—'}</td>
                            <td class="end strong"><span class="${tone(row.total)}">${money(row.total, { unit: false, sign: true })}</span><span class="cell-sub">${deltaText(row.totalPct)}</span></td>
                            ${periodMode ? html`<td class="end"><span class="${tone(row.period.pnl)}">${money(row.period.pnl, { unit: false, sign: true })}</span><span class="cell-sub">${deltaText(row.period.pct)}</span></td>` : ''}
                        </tr>`)}</tbody>
                </table></div>
            </article>`;
    }

    function historyPanel() {
        const rows = [...data.timeline].reverse();
        return html`
            <article class="card">
                <div class="card-head"><h2>تاریخچهٔ سود و زیان</h2><span class="sub">وضعیت در هر تاریخ، تازه‌ترین بالا</span></div>
                <div class="table-wrap"><table class="table">
                    <thead><tr><th>تاریخ</th><th class="end">ارزش</th><th class="end">بهای تمام‌شده</th><th class="end">سود و زیان باز</th><th class="end">محقق‌شده (تجمعی)</th><th class="end">برداشت‌شده (تجمعی)</th><th class="end">سود کل</th>${filters.mode === 'period' ? html`<th class="end">تغییر از ابتدای بازه</th>` : ''}</tr></thead>
                    <tbody>${rows.map((point) => html`
                        <tr>
                            <td>${jalaliDate(point.date)}</td>
                            <td class="end">${money(point.value, { unit: false })}</td>
                            <td class="end">${money(point.cost, { unit: false })}</td>
                            <td class="end ${tone(point.unrealized)}">${money(point.unrealized, { unit: false, sign: true })}</td>
                            <td class="end ${tone(point.realized)}">${money(point.realized, { unit: false, sign: true })}</td>
                            <td class="end">${point.withdrawn ? money(point.withdrawn, { unit: false }) : '—'}</td>
                            <td class="end strong ${tone(point.profit)}">${money(point.profit, { unit: false, sign: true })}</td>
                            ${filters.mode === 'period' ? html`<td class="end ${tone(point.delta)}">${money(point.delta, { unit: false, sign: true })}</td>` : ''}
                        </tr>`)}</tbody>
                </table></div>
            </article>`;
    }

    function withdrawalsPanel() {
        const { items, totals } = data.withdrawals;
        return html`
            <div class="summary-strip">
                <div><span class="label">مجموع برداشت‌ها</span><span class="value">${compactMoney(totals.amount, { unit: true })}</span></div>
                <div><span class="label">از دارایی‌ها</span><span class="value">${compactMoney(totals.fromAssets, { unit: true })}</span></div>
                <div><span class="label">به موجودی نقد</span><span class="value">${compactMoney(totals.toCash, { unit: true })}</span></div>
                <div><span class="label">خارج‌شده از برنامه</span><span class="value">${compactMoney(totals.external, { unit: true })}</span></div>
            </div>
            <article class="card">
                <div class="card-head">
                    <h2>تاریخچهٔ برداشت‌ها</h2>
                    <button type="button" class="btn btn-primary btn-sm" data-withdraw>${icon('plus', 'icon-sm')}<span>ثبت برداشت سود</span></button>
                </div>
                ${items.length ? html`<div class="list">${items.map((item) => html`
                    <div class="list-row withdrawal-row">
                        <span class="asset-avatar sm cat-cash">${icon('arrow-up-from-line')}</span>
                        <div class="grow">
                            <span class="title">${money(item.shownAmount)} <span class="badge ${item.destination === 'cash' ? 'buy' : ''}">${item.destination === 'cash' ? 'به موجودی نقد' : 'خارج از برنامه'}</span></span>
                            <span class="meta">${jalaliDate(item.date)} · ${item.allocations.map((part) => `${part.name}: ${compactMoney(part.amount)}`).join('، ')}${item.note && item.note !== 'برداشت سود' ? ` · ${item.note}` : ''}${item.cashLocation ? ` · ${item.cashLocation}` : ''}</span>
                        </div>
                        <button type="button" class="icon-btn plain icon-btn-sm" data-delete-withdrawal="${item.id}" aria-label="حذف برداشت" title="حذف برداشت">${icon('trash-2', 'icon-sm')}</button>
                    </div>`)}</div>` : html`<div class="empty"><p>در این گزارش برداشتی ثبت نشده است. با «ثبت برداشت سود» می‌توانید بخشی از سود دارایی‌ها یا موجودی نقد را برداشت کنید.</p></div>`}
            </article>`;
    }

    function realizedPanel() {
        const { items, total } = data.realized;
        return html`
            <article class="card">
                <div class="card-head"><h2>سود محقق‌شده از فروش‌ها</h2><span class="sub ${tone(total)}">${money(total, { sign: true })}</span></div>
                ${items.length ? html`<div class="table-wrap"><table class="table">
                    <thead><tr><th>تاریخ</th><th>دارایی</th><th class="end">مقدار</th><th class="end">قیمت فروش</th><th class="end">دریافتی</th><th class="end">بهای تمام‌شده</th><th class="end">سود و زیان</th><th>محل</th></tr></thead>
                    <tbody>${items.map((item) => html`
                        <tr>
                            <td>${jalaliDate(item.date)}</td>
                            <td class="strong">${item.name}</td>
                            <td class="end">${quantity(item.quantity)}</td>
                            <td class="end">${money(item.unitPrice, { unit: false })}</td>
                            <td class="end">${money(item.proceeds, { unit: false })}</td>
                            <td class="end">${money(item.costRemoved, { unit: false })}</td>
                            <td class="end strong ${tone(item.realized)}">${money(item.realized, { unit: false, sign: true })}</td>
                            <td>${item.location || '—'}</td>
                        </tr>`)}</tbody>
                </table></div>` : html`<div class="empty"><p>در این گزارش فروشی ثبت نشده است.</p></div>`}
            </article>`;
    }

    function drawChart() {
        destroyChart();
        const box = view.querySelector('[data-chart]');
        if (!box || !data || data.empty) return;
        const points = data.timeline;
        if (points.length < 2) {
            setHtml(box, html`<div class="chart-empty">برای رسم نمودار، بازهٔ انتخابی باید دست‌کم دو روز باشد.</div>`);
            return;
        }
        setHtml(box, html`<canvas role="img" aria-label="نمودار سود و زیان در طول زمان"></canvas>`);
        const periodMode = filters.mode === 'period';
        chart = lineChart(box.querySelector('canvas'), {
            dates: points.map((point) => point.date),
            series: [
                { label: periodMode ? 'تغییر نسبت به ابتدای بازه' : 'سود و زیان کل', values: points.map((point) => (periodMode ? point.delta : point.profit)), color: cssVar('--chart-line'), fill: cssVar('--chart-fill'), endDot: true },
                { label: periodMode ? 'سود و زیان کل' : 'سود و زیان باز', values: points.map((point) => (periodMode ? point.profit : point.unrealized)), color: cssVar('--chart-context') },
            ],
        });
    }

    function render() {
        destroyChart();
        if (data.empty) {
            setHtml(view, html`
                ${filterBar(data.options)}
                <div class="card"><div class="empty" style="padding:48px 24px">
                    <span class="empty-icon">${icon('chart-line')}</span>
                    <h3>${data.transactionCount === 0 && !filters.symbols.length && !filters.categories.length && !filters.locations.length ? 'هنوز تراکنشی برای محاسبه ثبت نشده است' : 'با این فیلترها داده‌ای پیدا نشد'}</h3>
                    <p>پس از ثبت خرید و فروش، سود و زیان دارایی‌ها اینجا محاسبه می‌شود.</p>
                </div></div>`);
            mountFilterControls(data.options);
            return;
        }
        const panels = { overview: overviewPanel, assets: assetsPanel, history: historyPanel, withdrawals: withdrawalsPanel, realized: realizedPanel };
        setHtml(view, html`
            <div class="dash pnl">
                ${filterBar(data.options)}
                ${kpis()}
                <div class="dash-toolbar">
                    <div class="segmented tabs" role="tablist" aria-label="بخش‌های گزارش" data-tabs>
                        ${TABS.map(([key, label]) => html`<button type="button" role="tab" data-tab="${key}" aria-selected="${key === tab}" aria-pressed="${key === tab}">${label}</button>`)}
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm" data-withdraw>${icon('arrow-up-from-line', 'icon-sm')}<span>ثبت برداشت سود</span></button>
                </div>
                <div class="stack" data-panel>${panels[tab]()}</div>
            </div>`);
        mountFilterControls(data.options);
        if (tab === 'overview') drawChart();
    }

    async function reload({ quiet = true } = {}) {
        if (quiet) view.classList.add('is-refreshing');
        try {
            data = await api.get(`/api/pnl?${params()}`);
            if (alive) render();
        } catch (error) {
            if (alive) {
                setHtml(view, html`<div class="alert error">${icon('circle-alert')}<div class="grow">${error.message}</div></div>`);
            }
        } finally {
            view.classList.remove('is-refreshing');
        }
    }

    function showTab(next) {
        tab = next;
        const panel = view.querySelector('[data-panel]');
        for (const button of view.querySelectorAll('[data-tab]')) {
            const on = button.dataset.tab === tab;
            button.setAttribute('aria-selected', String(on));
            button.setAttribute('aria-pressed', String(on));
        }
        destroyChart();
        const panels = { overview: overviewPanel, assets: assetsPanel, history: historyPanel, withdrawals: withdrawalsPanel, realized: realizedPanel };
        setHtml(panel, panels[tab]());
        if (tab === 'overview') drawChart();
    }

    const onClick = async (event) => {
        const tabButton = event.target.closest('[data-tab]');
        if (tabButton) {
            showTab(tabButton.dataset.tab);
            return;
        }
        const mode = event.target.closest('[data-mode] button');
        if (mode) {
            filters.mode = mode.dataset.value;
            reload();
            return;
        }
        const preset = event.target.closest('[data-preset]');
        if (preset) {
            filters.from = addDays(filters.to || todayIso(), -Number(preset.dataset.preset));
            reload();
            return;
        }
        if (event.target.closest('[data-clear]')) {
            Object.assign(filters, { symbols: [], categories: [], locations: [] });
            reload();
            return;
        }
        if (event.target.closest('[data-withdraw]')) {
            if (await openWithdrawDialog()) reload();
            return;
        }
        const remove = event.target.closest('[data-delete-withdrawal]');
        if (remove) {
            const confirmed = await confirmDialog({
                title: 'حذف برداشت سود',
                message: 'این برداشت حذف می‌شود و مقدار دارایی‌ها و موجودی نقد به حالت قبل از آن برمی‌گردد. ادامه می‌دهید؟',
                confirmText: 'حذف شود',
                danger: true,
            });
            if (!confirmed) return;
            try {
                await api.del(`/api/withdrawals/${encodeURIComponent(remove.dataset.deleteWithdrawal)}`);
                notify.success('برداشت حذف شد');
                store.dataChanged();
            } catch (error) {
                notify.error(error.message);
            }
            return;
        }
        const asset = event.target.closest('tr[data-asset]');
        if (asset) window.location.hash = `#/asset/${asset.dataset.asset}`;
    };
    const onKey = (event) => {
        const row = event.target.closest('tr[data-asset]');
        if (row && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            window.location.hash = `#/asset/${row.dataset.asset}`;
        }
    };
    view.addEventListener('click', onClick);
    view.addEventListener('keydown', onKey);

    const unsubscribe = [
        store.on('data-changed', () => reload()),
        store.on('synced', () => reload()),
        store.on('unit', () => data && render()),
        store.on('theme', () => tab === 'overview' && drawChart()),
    ];
    reload({ quiet: false });

    return {
        unmount() {
            alive = false;
            destroyChart();
            for (const select of selects) select.destroy();
            view.removeEventListener('click', onClick);
            view.removeEventListener('keydown', onKey);
            unsubscribe.forEach((off) => off());
        },
    };
}
