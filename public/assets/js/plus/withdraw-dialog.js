// Record a profit withdrawal: choose which holdings (and/or cash) the profit comes from, how much from
// each, and whether the money lands in cash or leaves the app.
import { html, icon, setHtml } from '../lib/dom.js';
import { api } from '../api.js';
import { store } from '../state.js';
import { money, quantity as formatQuantity, unitLabel, currencyLabel, toDisplay, fromDisplay, todayIso, number } from '../format.js';
import { openDialog, withBusy } from '../ui/dialog.js';
import { createDatePicker } from '../ui/datepicker.js';
import { bindNumberInput } from '../ui/number-input.js';
import { notify } from '../ui/toast.js';
import { createLocationInput, forgetLocations } from './location-input.js';

const CASH_KEY = '__cash__';

/** Resolves true when a withdrawal was recorded. */
export async function openWithdrawDialog() {
    let preview;
    try {
        preview = await api.get(`/api/withdrawals/preview?date=${todayIso()}`);
    } catch (error) {
        notify.error(error.message);
        return false;
    }

    return new Promise((resolve) => {
        const state = { destination: 'cash', date: todayIso(), preview, checked: new Set(), controls: new Map(), request: 0 };
        const instance = openDialog({
            title: 'ثبت برداشت سود',
            size: 'lg',
            body: html`
                <form class="form-grid withdraw-form" novalidate autocomplete="off">
                    <p class="full field-hint" style="margin:0">فقط از «سود» می‌توان برداشت کرد؛ سرمایهٔ اصلی در دارایی می‌ماند. مقدار دارایی به قیمت همان روز کم می‌شود و در سود برداشت‌شده ثبت می‌گردد.</p>
                    <div class="field"><span class="field-label">تاریخ برداشت (شمسی)</span><div data-date></div></div>
                    <div class="field full"><span class="field-label">مبلغ برداشت‌شده چه می‌شود؟</span>
                        <div class="segmented block" role="group" aria-label="مقصد" data-destination>
                            <button type="button" data-value="cash">به موجودی نقد اضافه شود</button>
                            <button type="button" data-value="external">از برنامه خارج می‌شود</button>
                        </div></div>
                    <div class="field full" data-cash-location-field><label for="wd-cash-location">محل نگهداری پول نقد <span class="muted">(اختیاری)</span></label><div data-cash-location></div></div>
                    <div class="full" data-sources></div>
                    <div class="full auto-split">
                        <div class="field"><label for="wd-total">تقسیم خودکار یک مبلغ بین گزینه‌های انتخاب‌شده</label>
                            <div class="input-group"><input id="wd-total" class="input" placeholder="مبلغ کل"><span class="addon">${currencyLabel()}</span>
                                <button type="button" class="btn btn-secondary btn-sm addon-btn" data-split>${icon('scale', 'icon-sm')}<span>تقسیم متناسب با سود</span></button></div></div>
                    </div>
                    <div class="field full"><label for="wd-note">یادداشت <span class="muted">(اختیاری)</span></label><input id="wd-note" class="input" maxlength="500" placeholder="مثلاً هزینهٔ تعمیر خانه"></div>
                    <div class="full tx-summary" data-summary></div>
                    <div class="full field-error" data-error role="alert"></div>
                </form>`,
            footer: html`<button type="button" class="btn btn-ghost" data-close>انصراف</button>
                <button type="button" class="btn btn-primary" data-save>${icon('check')}<span>ثبت برداشت</span></button>`,
            onClose: (result) => resolve(Boolean(result)),
        });

        const form = instance.body.querySelector('form');
        const $ = (selector) => form.querySelector(selector);
        const errorBox = $('[data-error]');
        const totalInput = bindNumberInput($('#wd-total'));
        const note = $('#wd-note');
        const cashLocation = createLocationInput($('[data-cash-location]'), { id: 'wd-cash-location' });

        const date = createDatePicker($('[data-date]'), {
            value: state.date,
            onChange: async (iso) => {
                const request = ++state.request;
                try {
                    const fresh = await api.get(`/api/withdrawals/preview?date=${iso}`);
                    if (request !== state.request) return;
                    state.date = iso;
                    state.preview = fresh;
                    renderSources();
                } catch (error) {
                    errorBox.textContent = error.message;
                }
            },
        });

        const sourceRows = () => {
            const rows = state.preview.assets.map((item) => ({
                key: item.symbol,
                name: item.name,
                sub: `${formatQuantity(item.quantity)} ${unitLabel(item.unit)}${item.price > 0 ? ` · قیمت ${money(item.price)}` : ' · قیمت پیدا نشد'}`,
                available: item.profit,
            }));
            if (state.destination !== 'cash' && state.preview.cash.balance > 0) {
                rows.push({ key: CASH_KEY, name: 'پول نقد', sub: 'برداشت مستقیم از موجودی نقد', available: state.preview.cash.balance });
            }
            return rows;
        };

        function renderSources() {
            const rows = sourceRows();
            for (const key of [...state.checked]) if (!rows.some((row) => row.key === key)) state.checked.delete(key);
            state.controls.clear();
            const target = $('[data-sources]');
            if (!rows.length) {
                setHtml(target, html`<div class="alert warn" style="margin:0">${icon('triangle-alert')}<div class="grow">در این تاریخ دارایی دارای سود قابل برداشتی ندارید.</div></div>`);
                update();
                return;
            }
            setHtml(target, html`
                <div class="table-wrap"><table class="table withdraw-table">
                    <thead><tr><th style="width:36px"><span class="sr-only">انتخاب</span></th><th>از کدام دارایی</th><th class="end">سود قابل برداشت</th><th>مبلغ برداشت (${currencyLabel()})</th></tr></thead>
                    <tbody>${rows.map((row) => html`
                        <tr data-row="${row.key}" class="${row.available > 0 ? '' : 'is-spent'}">
                            <td><input type="checkbox" data-check aria-label="${row.name}" ${row.available > 0 ? '' : html`disabled`} ${state.checked.has(row.key) ? html`checked` : ''}></td>
                            <td><span class="strong">${row.name}</span><span class="cell-sub">${row.sub}</span></td>
                            <td class="end">${money(row.available, { unit: false })}<button type="button" class="link-btn max-link" data-max="${row.key}" ${row.available > 0 ? '' : html`hidden`}>همه</button></td>
                            <td><input class="input num" placeholder="۰" data-amount ${state.checked.has(row.key) ? '' : html`disabled`}></td>
                        </tr>`)}</tbody>
                </table></div>`);
            for (const row of target.querySelectorAll('tr[data-row]')) {
                const key = row.dataset.row;
                const control = bindNumberInput(row.querySelector('[data-amount]'), { onChange: update });
                state.controls.set(key, control);
            }
            update();
        }

        const available = (key) => (sourceRows().find((row) => row.key === key) || { available: 0 }).available;
        const amountOf = (key) => {
            const control = state.controls.get(key);
            return control && control.value !== null ? fromDisplay(control.value) : 0;
        };
        const total = () => [...state.checked].reduce((sum, key) => sum + amountOf(key), 0);

        function update() {
            const sum = total();
            const rows = [html`<div class="row"><span>مجموع برداشت</span><strong>${money(sum)}</strong></div>`];
            for (const key of state.checked) {
                if (amountOf(key) > available(key) + 1e-6) {
                    rows.push(html`<div class="row neg"><span class="with-icon">${icon('triangle-alert', 'icon-sm')}مبلغ یکی از ردیف‌ها از سود قابل برداشت آن بیشتر است.</span></div>`);
                    break;
                }
            }
            setHtml($('[data-summary]'), rows);
        }

        function setChecked(key, on) {
            if (on) state.checked.add(key);
            else state.checked.delete(key);
            const row = form.querySelector(`tr[data-row="${CSS.escape(key)}"]`);
            if (!row) return;
            const input = row.querySelector('[data-amount]');
            input.disabled = !on;
            if (!on) state.controls.get(key).value = null;
            update();
        }

        function setDestination(value) {
            state.destination = value;
            for (const button of $('[data-destination]').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
            $('[data-cash-location-field]').hidden = value !== 'cash';
            renderSources();
        }

        form.addEventListener('change', (event) => {
            const box = event.target.closest('[data-check]');
            if (box) setChecked(box.closest('tr').dataset.row, box.checked);
        });
        form.addEventListener('click', (event) => {
            const choose = event.target.closest('[data-destination] button');
            if (choose) {
                setDestination(choose.dataset.value);
                return;
            }
            const max = event.target.closest('[data-max]');
            if (max) {
                const key = max.dataset.max;
                const box = form.querySelector(`tr[data-row="${CSS.escape(key)}"] [data-check]`);
                if (box && !box.checked) {
                    box.checked = true;
                    setChecked(key, true);
                }
                state.controls.get(key).value = toDisplay(Math.floor(available(key)));
                update();
                return;
            }
            if (event.target.closest('[data-split]')) {
                errorBox.textContent = '';
                const amount = totalInput.value === null ? 0 : fromDisplay(totalInput.value);
                const keys = [...state.checked];
                if (!(amount > 0)) {
                    errorBox.textContent = 'مبلغ کل را وارد کنید';
                    return;
                }
                if (!keys.length) {
                    errorBox.textContent = 'ابتدا دارایی‌هایی را که می‌خواهید از آن‌ها برداشت شود انتخاب کنید';
                    return;
                }
                const capacity = keys.reduce((sum, key) => sum + available(key), 0);
                if (amount > capacity + 1e-6) {
                    errorBox.textContent = `مبلغ از مجموع سود قابل برداشت انتخاب‌شده (${money(capacity)}) بیشتر است`;
                    return;
                }
                let left = Math.floor(amount);
                keys.forEach((key, index) => {
                    const part = index === keys.length - 1 ? left : Math.min(Math.floor(available(key)), Math.floor((amount * available(key)) / capacity));
                    left -= part;
                    state.controls.get(key).value = toDisplay(Math.max(0, part));
                });
                update();
            }
        });

        const save = instance.foot.querySelector('[data-save]');
        save.addEventListener('click', () => withBusy(save, async () => {
            errorBox.textContent = '';
            if (!date.isValid()) {
                errorBox.textContent = 'تاریخ معتبر نیست';
                return;
            }
            const allocations = [...state.checked]
                .map((key) => ({ key, amount: amountOf(key) }))
                .filter((item) => item.amount > 0)
                .map((item) => (item.key === CASH_KEY ? { type: 'cash', amount: item.amount } : { type: 'asset', symbol: item.key, amount: item.amount }));
            if (!allocations.length) {
                errorBox.textContent = 'حداقل از یک دارایی مبلغی برای برداشت وارد کنید';
                return;
            }
            try {
                const result = await api.post('/api/withdrawals', {
                    date: date.value,
                    destination: state.destination,
                    cashLocation: cashLocation.value,
                    note: note.value.trim(),
                    allocations,
                });
                forgetLocations();
                notify.success(`برداشت ${number(Math.round(toDisplay(result.amount)))} ${currencyLabel()} ثبت شد`);
                store.dataChanged();
                instance.close(true);
            } catch (error) {
                errorBox.textContent = error.message;
            }
        }));

        setDestination('cash');
    });
}
