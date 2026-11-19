// Dialogs of the cash page: add or reduce cash, and manage the sources cash can come from.
import { html, icon, setHtml } from '../lib/dom.js';
import { api } from '../api.js';
import { store } from '../state.js';
import { money, currencyLabel, toDisplay, fromDisplay, todayIso, jalaliDate } from '../format.js';
import { openDialog, confirmDialog, withBusy } from '../ui/dialog.js';
import { createDatePicker } from '../ui/datepicker.js';
import { bindNumberInput } from '../ui/number-input.js';
import { notify } from '../ui/toast.js';
import { createLocationInput, forgetLocations } from './location-input.js';

export const CASH_SYMBOL = 'CASH_IRT';

/* ---------- sources ---------- */

export function openSourcesManager() {
    return new Promise((resolve) => {
        let changed = false;
        let editing = null;
        let sources = [];
        const instance = openDialog({
            title: 'منبع‌های افزودن وجه',
            body: html`<div class="skeleton" style="height:160px"></div>`,
            footer: html`<span class="grow"></span><button type="button" class="btn btn-primary" data-close>بستن</button>`,
            onClose: () => resolve(changed),
        });

        function render() {
            setHtml(instance.body, html`
                <p class="field-hint" style="margin-top:0">هر بار که پولی به موجودی نقد اضافه می‌کنید، منبع آن را انتخاب می‌کنید و گزارش هر منبع جداگانه ساخته می‌شود. منبع‌های دلخواه خودتان را هم اضافه کنید.</p>
                <form class="source-add" data-add novalidate>
                    <input class="input" maxlength="60" placeholder="نام منبع جدید، مثلاً سود اجاره" aria-label="نام منبع جدید">
                    <button type="submit" class="btn btn-secondary">${icon('plus')}<span>افزودن</span></button>
                </form>
                <ul class="source-list">
                    ${sources.map((source) => html`
                        <li class="${source.archived ? 'is-archived' : ''}" data-id="${source.id}">
                            ${editing === source.id ? html`
                                <input class="input" maxlength="60" value="${source.name}" aria-label="نام منبع" data-rename-input>
                                <button type="button" class="icon-btn plain icon-btn-sm" data-save-name="${source.id}" aria-label="ذخیره" title="ذخیره">${icon('check', 'icon-sm')}</button>
                                <button type="button" class="icon-btn plain icon-btn-sm" data-cancel aria-label="انصراف" title="انصراف">${icon('x', 'icon-sm')}</button>` : html`
                                <span class="grow">
                                    <strong>${source.name}</strong>
                                    ${source.system ? html`<span class="badge" title="برنامه خودکار از این منبع استفاده می‌کند">خودکار</span>` : source.builtin ? html`<span class="badge">آماده</span>` : ''}
                                    ${source.archived ? html`<span class="badge warn">مخفی</span>` : ''}
                                </span>
                                <button type="button" class="icon-btn plain icon-btn-sm" data-edit="${source.id}" aria-label="تغییر نام" title="تغییر نام">${icon('pencil', 'icon-sm')}</button>
                                ${source.system ? '' : html`<button type="button" class="icon-btn plain icon-btn-sm" data-toggle="${source.id}" aria-label="${source.archived ? 'نمایش' : 'مخفی کردن'}" title="${source.archived ? 'نمایش در فهرست' : 'مخفی کردن از فهرست'}">${icon(source.archived ? 'eye' : 'eye-off', 'icon-sm')}</button>`}
                                ${source.builtin ? '' : html`<button type="button" class="icon-btn plain icon-btn-sm" data-delete="${source.id}" aria-label="حذف" title="حذف">${icon('trash-2', 'icon-sm')}</button>`}`}
                        </li>`)}
                </ul>`);
        }

        async function load() {
            sources = await api.get('/api/cash/sources');
            render();
        }

        async function run(task) {
            try {
                await task();
                changed = true;
                await load();
            } catch (error) {
                notify.error(error.message);
            }
        }

        instance.body.addEventListener('submit', (event) => {
            if (!event.target.matches('[data-add]')) return;
            event.preventDefault();
            const input = event.target.querySelector('input');
            run(async () => {
                await api.post('/api/cash/sources', { name: input.value });
                input.value = '';
            });
        });
        instance.body.addEventListener('click', (event) => {
            const pick = (attribute) => {
                const element = event.target.closest(`[${attribute}]`);
                return element ? element.getAttribute(attribute) : null;
            };
            const edit = pick('data-edit');
            if (edit) {
                editing = edit;
                render();
                const input = instance.body.querySelector('[data-rename-input]');
                if (input) {
                    input.focus();
                    input.select();
                }
                return;
            }
            if (event.target.closest('[data-cancel]')) {
                editing = null;
                render();
                return;
            }
            const save = pick('data-save-name');
            if (save) {
                run(async () => {
                    await api.put(`/api/cash/sources/${encodeURIComponent(save)}`, { name: instance.body.querySelector('[data-rename-input]').value });
                    editing = null;
                });
                return;
            }
            const toggle = pick('data-toggle');
            if (toggle) {
                const source = sources.find((item) => item.id === toggle);
                run(() => api.put(`/api/cash/sources/${encodeURIComponent(toggle)}`, { archived: !source.archived }));
                return;
            }
            const remove = pick('data-delete');
            if (remove) {
                const source = sources.find((item) => item.id === remove);
                confirmDialog({ title: 'حذف منبع', message: `منبع «${source.name}» حذف شود؟`, confirmText: 'حذف شود', danger: true })
                    .then((confirmed) => confirmed && run(() => api.del(`/api/cash/sources/${encodeURIComponent(remove)}`)));
            }
        });
        instance.body.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target.matches('[data-rename-input]')) {
                event.preventDefault();
                const save = instance.body.querySelector('[data-save-name]');
                if (save) save.click();
            }
        });
        load().catch((error) => {
            notify.error(error.message);
            instance.close(null);
        });
    });
}

/* ---------- add or reduce cash ---------- */

/** Add or edit a cash entry. Resolves true when something was saved or deleted. */
export async function openCashForm({ transaction = null, side = 'buy' } = {}) {
    let sources;
    try {
        [sources] = await Promise.all([api.get('/api/cash/sources'), store.loadPortfolio()]);
    } catch (error) {
        notify.error(error.message);
        return false;
    }
    const balance = store.portfolio && store.portfolio.totals ? store.portfolio.totals.cash || 0 : 0;

    return new Promise((resolve) => {
        const editing = Boolean(transaction);
        const locked = editing && transaction.withdrawalId;
        const state = { side: editing ? transaction.side : side };
        const instance = openDialog({
            title: editing ? 'ویرایش ردیف پول نقد' : 'پول نقد',
            body: html`
                <form class="form-grid" novalidate autocomplete="off">
                    ${locked ? html`<div class="full alert info" style="margin:0">${icon('info')}<div class="grow">این ردیف بخشی از یک برداشت سود است و فقط از بخش «سود و زیان › برداشت سود» قابل تغییر یا حذف است.</div></div>` : ''}
                    ${editing && transaction.linkId ? html`<div class="full alert info" style="margin:0">${icon('info')}<div class="grow">این ردیف همراه یک تراکنش دارایی ثبت شده است. با ویرایش آن تراکنش، مبلغ این ردیف هم خودکار به‌روز می‌شود.</div></div>` : ''}
                    <div class="full segmented block side" role="group" aria-label="نوع عملیات" data-side>
                        <button type="button" data-value="buy">${icon('arrow-down-left', 'icon-sm')}<span>افزودن وجه</span></button>
                        <button type="button" data-value="sell">${icon('arrow-up-right', 'icon-sm')}<span>کاهش موجودی</span></button>
                    </div>
                    <div class="field">
                        <label for="cash-amount">مبلغ</label>
                        <div class="input-group"><input id="cash-amount" class="input" placeholder="۰"><span class="addon">${currencyLabel()}</span></div>
                        <span class="field-hint">موجودی نقد فعلی: <strong>${money(balance)}</strong></span>
                    </div>
                    <div class="field"><span class="field-label">تاریخ (شمسی)</span><div data-date></div></div>
                    <div class="field full" data-source-field>
                        <label for="cash-source">این وجه از کجا آمده است؟</label>
                        <div class="input-group">
                            <select id="cash-source" class="select"></select>
                            <button type="button" class="btn btn-ghost btn-sm addon-btn" data-manage-sources>${icon('pen-line', 'icon-sm')}<span>مدیریت منبع‌ها</span></button>
                        </div>
                    </div>
                    <div class="field"><label for="cash-location">محل نگهداری <span class="muted">(اختیاری)</span></label><div data-location></div></div>
                    <div class="field"><label for="cash-note">یادداشت <span class="muted">(اختیاری)</span></label>
                        <input id="cash-note" class="input" maxlength="500" placeholder="مثلاً حقوق مهر"></div>
                    <div class="full field-error" data-error role="alert"></div>
                    <button type="submit" hidden></button>
                </form>`,
            footer: html`
                ${editing && !locked ? html`<button type="button" class="btn btn-danger-ghost" data-delete>${icon('trash-2')}<span>حذف</span></button>` : ''}
                <span class="grow"></span>
                <button type="button" class="btn btn-ghost" data-close>انصراف</button>
                ${locked ? '' : html`<button type="button" class="btn btn-primary" data-save>${icon('check')}<span data-save-label>${editing ? 'ذخیره تغییرات' : 'ثبت'}</span></button>`}`,
            onClose: (result) => resolve(Boolean(result)),
        });

        const form = instance.body.querySelector('form');
        const $ = (selector) => form.querySelector(selector);
        const errorBox = $('[data-error]');
        const amount = bindNumberInput($('#cash-amount'));
        const date = createDatePicker($('[data-date]'), { value: editing ? transaction.date : todayIso() });
        const location = createLocationInput($('[data-location]'), { value: editing ? transaction.location || '' : '', id: 'cash-location' });
        const note = $('#cash-note');
        const sourceSelect = $('#cash-source');

        function fillSources(selected = null) {
            const current = selected || sourceSelect.value;
            const visible = sources.filter((item) => !item.archived || item.id === current);
            setHtml(sourceSelect, visible.map((item) => html`<option value="${item.id}">${item.name}</option>`));
            if (current && visible.some((item) => item.id === current)) sourceSelect.value = current;
        }

        function setSide(value) {
            state.side = value;
            for (const button of $('[data-side]').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
            $('[data-source-field]').hidden = value !== 'buy';
            const label = instance.foot.querySelector('[data-save-label]');
            if (label && !editing) label.textContent = value === 'buy' ? 'ثبت افزودن وجه' : 'ثبت کاهش موجودی';
        }

        fillSources(editing && transaction.sourceId ? transaction.sourceId : 'src_savings_outside');
        if (editing) {
            amount.value = toDisplay(transaction.quantity);
            note.value = transaction.note || '';
        }
        setSide(state.side);
        if (!editing) setTimeout(() => $('#cash-amount').focus(), 60);
        if (locked) for (const element of form.querySelectorAll('input, select, button')) element.disabled = true;

        $('[data-side]').addEventListener('click', (event) => {
            const button = event.target.closest('button[data-value]');
            if (button && !locked) setSide(button.dataset.value);
        });
        $('[data-manage-sources]').addEventListener('click', async () => {
            await openSourcesManager();
            sources = await api.get('/api/cash/sources');
            fillSources();
        });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const save = instance.foot.querySelector('[data-save]');
            if (save) save.click();
        });

        const saveButton = instance.foot.querySelector('[data-save]');
        if (saveButton) {
            saveButton.addEventListener('click', () => withBusy(saveButton, async () => {
                errorBox.textContent = '';
                const value = amount.value === null ? null : fromDisplay(amount.value);
                const problems = [];
                if (!(value > 0)) problems.push('مبلغ را وارد کنید');
                if (!date.isValid()) problems.push('تاریخ معتبر نیست');
                if (problems.length) {
                    errorBox.textContent = problems.join('، ');
                    return;
                }
                const payload = {
                    symbol: CASH_SYMBOL,
                    side: state.side,
                    date: date.value,
                    quantity: value,
                    unitPrice: 1,
                    fee: 0,
                    sourceId: state.side === 'buy' ? sourceSelect.value : undefined,
                    location: location.value,
                    note: note.value.trim(),
                };
                try {
                    if (editing) await api.put(`/api/transactions/${transaction.id}`, payload);
                    else await api.post('/api/transactions', payload);
                    forgetLocations();
                    notify.success(editing ? 'ردیف ویرایش شد' : state.side === 'buy' ? 'وجه به موجودی نقد اضافه شد' : 'موجودی نقد کاهش یافت');
                    store.dataChanged();
                    instance.close(true);
                } catch (error) {
                    errorBox.textContent = error.message;
                }
            }));
        }

        const deleteButton = instance.foot.querySelector('[data-delete]');
        if (deleteButton) {
            deleteButton.addEventListener('click', async () => {
                const confirmed = await confirmDialog({
                    title: 'حذف ردیف',
                    message: `این ردیف پول نقد (${jalaliDate(transaction.date)}) برای همیشه حذف می‌شود. ادامه می‌دهید؟`,
                    confirmText: 'حذف شود',
                    danger: true,
                });
                if (!confirmed) return;
                try {
                    await api.del(`/api/transactions/${transaction.id}`);
                    notify.success('ردیف حذف شد');
                    store.dataChanged();
                    instance.close(true);
                } catch (error) {
                    errorBox.textContent = error.message;
                }
            });
        }
    });
}
