// The lock screen and the "App lock" section of Settings (in-app editions only).
import { html, icon, setHtml } from '../lib/dom.js';
import { openDialog, withBusy } from '../ui/dialog.js';
import { notify } from '../ui/toast.js';
import { faDigits } from '../format.js';
import * as lock from './lock.js';

/* ---------- the lock screen ---------- */

export function mountLockScreen() {
    const screen = document.createElement('div');
    screen.className = 'lock-screen';
    screen.hidden = true;
    setHtml(screen, html`
        <div class="lock-card card">
            <img class="brand-mark" src="assets/img/logo.svg" alt="" width="56" height="56">
            <h1 id="lock-title">دلاربان پلاس قفل است</h1>
            <p class="muted">برای ادامه، رمز برنامه را وارد کنید.</p>
            <form class="lock-form" novalidate>
                <div class="field">
                    <label for="lock-password" class="sr-only">رمز برنامه</label>
                    <div class="input-group eye-start">
                        <input id="lock-password" class="input ltr" type="password" autocomplete="off" dir="ltr" placeholder="رمز برنامه">
                        <button type="button" class="icon-btn plain icon-btn-sm addon-btn" data-reveal aria-label="نمایش رمز">${icon('eye', 'icon-sm')}</button>
                    </div>
                </div>
                <div class="field-error" data-error role="alert"></div>
                <button type="submit" class="btn btn-primary btn-block" style="height:46px">${icon('lock-open')}<span>باز کردن</span></button>
            </form>
            <div class="lock-hint" data-hint hidden></div>
            <div class="lock-links">
                <button type="button" class="link-btn" data-show-hint>یادآوری رمز</button>
                <button type="button" class="link-btn" data-forgot>رمز را فراموش کرده‌ام</button>
            </div>
        </div>`);
    document.body.append(screen);

    const form = screen.querySelector('form');
    const input = screen.querySelector('#lock-password');
    const error = screen.querySelector('[data-error]');
    const hintBox = screen.querySelector('[data-hint]');
    const hintButton = screen.querySelector('[data-show-hint]');
    let retryTimer = null;

    function sync() {
        const locked = lock.isLocked();
        screen.hidden = !locked;
        document.body.classList.toggle('is-locked', locked);
        document.documentElement.classList.toggle('is-locked', locked);
        if (locked) {
            input.value = '';
            error.textContent = '';
            hintBox.hidden = true;
            hintButton.hidden = !lock.hint();
            setTimeout(() => input.focus(), 50);
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!input.value) return;
        error.textContent = '';
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            const result = await lock.unlock(input.value);
            if (!result.ok) {
                input.select();
                if (result.retryAfter > 0) {
                    let left = result.retryAfter;
                    const tick = () => {
                        error.textContent = `رمز نادرست است. ${faDigits(left)} ثانیه دیگر دوباره امتحان کنید.`;
                        if (left <= 0) {
                            error.textContent = 'رمز نادرست است.';
                            return;
                        }
                        left -= 1;
                        retryTimer = setTimeout(tick, 1000);
                    };
                    clearTimeout(retryTimer);
                    tick();
                } else {
                    error.textContent = 'رمز نادرست است.';
                }
            }
        } finally {
            submit.disabled = false;
        }
    });
    screen.querySelector('[data-reveal]').addEventListener('click', (event) => {
        const visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        setHtml(event.currentTarget, icon(visible ? 'eye' : 'eye-off', 'icon-sm'));
    });
    hintButton.addEventListener('click', () => {
        const text = lock.hint();
        setHtml(hintBox, html`${icon('circle-help', 'icon-sm')}<span>یادآور شما: <strong>${text}</strong></span>`);
        hintBox.hidden = false;
    });
    screen.querySelector('[data-forgot]').addEventListener('click', openForgotDialog);

    lock.onLockChange(sync);
    sync();
}

function openForgotDialog() {
    const instance = openDialog({
        title: 'فراموشی رمز',
        size: 'sm',
        body: html`
            <p class="dialog-message">دلاربان پلاس هیچ اطلاعاتی از شما دریافت نمی‌کند و رمز شما جایی ذخیره نشده است؛ بنابراین <strong>بازیابی رمز ممکن نیست</strong>.</p>
            <p class="dialog-message">تنها راه، حذف برنامه و نصب دوباره آن است (یا با دکمهٔ زیر همهٔ اطلاعات این برنامه را روی همین دستگاه پاک کنید). اگر فایل پشتیبان دارید، بعد از آن می‌توانید همه چیز را بازیابی کنید.</p>
            <div class="field"><label for="wipe-confirm">برای تأیید، کلمهٔ «حذف» را بنویسید</label><input id="wipe-confirm" class="input" autocomplete="off"></div>
            <div class="field-error" data-error role="alert"></div>`,
        footer: html`
            <button type="button" class="btn btn-ghost" data-close>بازگشت</button>
            <button type="button" class="btn btn-danger" data-wipe>${icon('trash-2')}<span>پاک کردن همه اطلاعات این دستگاه</span></button>`,
    });
    const button = instance.foot.querySelector('[data-wipe]');
    button.addEventListener('click', () => withBusy(button, async () => {
        if (instance.body.querySelector('#wipe-confirm').value.trim() !== 'حذف') {
            instance.body.querySelector('[data-error]').textContent = 'کلمهٔ «حذف» را درست بنویسید.';
            return;
        }
        await lock.wipeEverything();
        window.location.reload();
    }));
}

/* ---------- Settings › App lock ---------- */

function passwordFields({ prefix, withCurrent }) {
    return html`
        ${withCurrent ? html`<div class="field full"><label for="${prefix}-current">رمز فعلی</label>
            <input id="${prefix}-current" class="input" type="password" autocomplete="current-password"></div>` : ''}
        <div class="field"><label for="${prefix}-password">${withCurrent ? 'رمز جدید' : 'رمز'}</label>
            <input id="${prefix}-password" class="input" type="password" autocomplete="new-password" minlength="4"></div>
        <div class="field"><label for="${prefix}-confirm">تکرار رمز</label>
            <input id="${prefix}-confirm" class="input" type="password" autocomplete="new-password" minlength="4"></div>
        <div class="field full"><label for="${prefix}-hint">یادآور رمز <span class="muted">(اختیاری)</span></label>
            <input id="${prefix}-hint" class="input" maxlength="120" placeholder="مثلاً اسم اولین مدرسه">
            <span class="field-hint">این یادآور روی صفحهٔ قفل و بدون رمز نمایش داده می‌شود. خود رمز را در آن ننویسید.</span></div>`;
}

const FORGET_WARNING = html`
    <div class="alert warn" style="margin:0">
        ${icon('triangle-alert')}
        <div class="grow"><strong>رمز را فراموش نکنید.</strong> چون هیچ اطلاعاتی از کاربران دریافت نمی‌شود، در صورت فراموشی رمز راه بازیابی وجود ندارد و برای استفاده دوباره باید برنامه را حذف و دوباره نصب کنید (اطلاعات روی همین دستگاه از بین می‌رود؛ از فایل پشتیبان می‌توانید بازیابی کنید).</div>
    </div>`;

/** Renders the section into `section` and returns a function that removes its listeners. */
export function mountLockSettings(section) {
    function render() {
        const enabled = lock.isEnabled();
        setHtml(section, html`
            <header>
                <h2>قفل برنامه</h2>
                <p>با یک رمز، برنامه را قفل کنید تا کسی جز شما نتواند آن را باز کند. رمز فقط روی همین دستگاه نگه‌داری می‌شود.</p>
            </header>
            <div class="settings-body">
                ${!lock.canUseLock() ? html`<div class="alert error" style="margin:0">${icon('circle-alert')}<div class="grow">این محیط از رمزنگاری لازم برای قفل پشتیبانی نمی‌کند.</div></div>` : ''}
                ${FORGET_WARNING}
                ${enabled ? html`
                    <div class="field">
                        <label for="auto-lock">قفل خودکار پس از خروج از برنامه</label>
                        <select id="auto-lock" class="select" data-auto-lock>
                            ${lock.AUTO_LOCK_CHOICES.map(([minutes, label]) => html`<option value="${minutes}" ${minutes === lock.autoLockMinutes() ? html`selected` : ''}>${label}</option>`)}
                        </select>
                    </div>
                    <div class="settings-actions">
                        <button type="button" class="btn btn-primary" data-lock-now>${icon('lock')}<span>قفل کن</span></button>
                        <button type="button" class="btn btn-secondary" data-change>${icon('key-round')}<span>تغییر رمز و یادآور</span></button>
                        <button type="button" class="btn btn-danger-ghost" data-disable>${icon('lock-open')}<span>برداشتن قفل</span></button>
                    </div>
                    ${lock.hint() ? html`<p class="small muted">یادآور فعلی: ${lock.hint()}</p>` : ''}` : html`
                    <form class="form-grid" data-enable novalidate autocomplete="off">
                        ${passwordFields({ prefix: 'lock-new', withCurrent: false })}
                        <div class="full field-error" data-error role="alert"></div>
                        <div class="full settings-actions"><button type="submit" class="btn btn-primary" ${lock.canUseLock() ? '' : html`disabled`}>${icon('lock')}<span>فعال‌سازی قفل</span></button></div>
                    </form>`}
            </div>`);
    }

    const onSubmit = async (event) => {
        if (!event.target.matches('[data-enable]')) return;
        event.preventDefault();
        const form = event.target;
        const error = form.querySelector('[data-error]');
        const password = form.querySelector('#lock-new-password').value;
        if (password !== form.querySelector('#lock-new-confirm').value) {
            error.textContent = 'تکرار رمز با آن یکسان نیست';
            return;
        }
        try {
            await lock.enable({ password, hint: form.querySelector('#lock-new-hint').value });
            notify.success('قفل برنامه فعال شد');
            render();
        } catch (failure) {
            error.textContent = failure.message;
        }
    };

    const onClick = async (event) => {
        if (event.target.closest('[data-lock-now]')) {
            lock.lock();
            return;
        }
        if (event.target.closest('[data-change]')) {
            openChangeDialog(render);
            return;
        }
        if (event.target.closest('[data-disable]')) {
            openDisableDialog(render);
        }
    };

    const onChange = (event) => {
        if (event.target.matches('[data-auto-lock]')) {
            lock.setAutoLock(event.target.value);
            notify.success('قفل خودکار ذخیره شد');
        }
    };

    section.addEventListener('submit', onSubmit);
    section.addEventListener('click', onClick);
    section.addEventListener('change', onChange);
    render();
    return () => {
        section.removeEventListener('submit', onSubmit);
        section.removeEventListener('click', onClick);
        section.removeEventListener('change', onChange);
    };
}

function openChangeDialog(done) {
    const instance = openDialog({
        title: 'تغییر رمز و یادآور',
        body: html`<form class="form-grid" novalidate autocomplete="off">${passwordFields({ prefix: 'chg', withCurrent: true })}<div class="full field-error" data-error role="alert"></div></form>`,
        footer: html`<button type="button" class="btn btn-ghost" data-close>انصراف</button>
            <button type="button" class="btn btn-primary" data-save>${icon('check')}<span>ذخیره</span></button>`,
    });
    const body = instance.body;
    const save = instance.foot.querySelector('[data-save]');
    save.addEventListener('click', () => withBusy(save, async () => {
        const error = body.querySelector('[data-error]');
        const password = body.querySelector('#chg-password').value;
        if (password !== body.querySelector('#chg-confirm').value) {
            error.textContent = 'تکرار رمز با آن یکسان نیست';
            return;
        }
        try {
            await lock.changePassword({ current: body.querySelector('#chg-current').value, password, hint: body.querySelector('#chg-hint').value });
            notify.success('رمز تغییر کرد');
            instance.close(true);
            done();
        } catch (failure) {
            error.textContent = failure.message;
        }
    }));
}

function openDisableDialog(done) {
    const instance = openDialog({
        title: 'برداشتن قفل',
        size: 'sm',
        body: html`<p class="dialog-message">برای برداشتن قفل، رمز فعلی را وارد کنید.</p>
            <div class="field"><label for="dis-current" class="sr-only">رمز فعلی</label><input id="dis-current" class="input" type="password" autocomplete="current-password"></div>
            <div class="field-error" data-error role="alert"></div>`,
        footer: html`<button type="button" class="btn btn-ghost" data-close>انصراف</button>
            <button type="button" class="btn btn-danger" data-save>${icon('lock-open')}<span>برداشتن قفل</span></button>`,
    });
    const save = instance.foot.querySelector('[data-save]');
    save.addEventListener('click', () => withBusy(save, async () => {
        try {
            await lock.disable(instance.body.querySelector('#dis-current').value);
            notify.success('قفل برداشته شد');
            instance.close(true);
            done();
        } catch (failure) {
            instance.body.querySelector('[data-error]').textContent = failure.message;
        }
    }));
}

