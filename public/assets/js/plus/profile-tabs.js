// Profile tabs at the top of the app. Every profile is a completely separate workspace
// (its own assets, transactions, cash, stocks and settings); nothing is shared between tabs.
import { html, icon, setHtml } from '../lib/dom.js';
import { api, IS_LOCAL, setServerProfile } from '../api.js';
import { store } from '../state.js';
import { openDialog, confirmDialog, withBusy } from '../ui/dialog.js';
import { notify } from '../ui/toast.js';

const MAX_NAME = 40;

/** Reloads everything after the open profile changed behind the page's back (it was deleted). */
async function reopen() {
    store.reset();
    await store.bootstrap();
    store.emit('profile', store.activeProfile);
}

async function readBackupFile(input) {
    const file = input.files && input.files[0];
    if (!file) return null;
    let payload;
    try {
        payload = JSON.parse(await file.text());
    } catch {
        throw new Error('فایل انتخاب‌شده JSON معتبر نیست');
    }
    if (!payload || (payload.app !== 'DollarBaan' && payload.app !== 'DollarBaanPlus')) throw new Error('این فایل، پشتیبان دلاربان یا دلاربان پلاس نیست');
    if (payload.kind === 'full') throw new Error('این فایل پشتیبان کامل همه پروفایل‌هاست؛ آن را از «تنظیمات › پشتیبان‌گیری» بازیابی کنید');
    return payload;
}

/** `payload` (already read from a backup file) fills the new profile; `name` is the suggested name. */
export function openAddProfile({ payload: preset = null, name: suggested = '' } = {}) {
    const instance = openDialog({
        title: 'پروفایل جدید',
        size: 'sm',
        body: html`
            <form class="form-grid" novalidate autocomplete="off">
                <p class="full field-hint">هر پروفایل محیط کاملاً جداگانه‌ای است؛ دارایی‌ها، تراکنش‌ها و تنظیمات پروفایل‌ها هیچ ارتباطی با هم ندارند.</p>
                <div class="field full"><label for="pf-name">نام پروفایل</label>
                    <input id="pf-name" class="input" maxlength="${MAX_NAME}" value="${suggested}" placeholder="مثلاً خانواده یا شرکت" required></div>
                <div class="field full" ${preset ? html`hidden` : ''}><span class="field-label">پر کردن از فایل پشتیبان <span class="muted">(اختیاری)</span></span>
                    <label class="btn btn-secondary">${icon('upload')}<span data-file-label>انتخاب فایل…</span>
                        <input type="file" class="sr-only" accept="application/json,.json" data-file></label>
                    <span class="field-hint">فایل پشتیبان دلاربان پلاس یا دلاربان (نسخهٔ اصلی) را می‌توانید همین‌جا در پروفایل جدید بازیابی کنید.</span></div>
                <div class="full field-error" data-error role="alert"></div>
            </form>`,
        footer: html`<button type="button" class="btn btn-ghost" data-close>انصراف</button>
            <button type="button" class="btn btn-primary" data-save>${icon('check')}<span>ساخت پروفایل</span></button>`,
    });
    const body = instance.body;
    const file = body.querySelector('[data-file]');
    file.addEventListener('change', () => {
        body.querySelector('[data-file-label]').textContent = file.files[0] ? file.files[0].name : 'انتخاب فایل…';
    });
    body.querySelector('#pf-name').focus();
    const save = instance.foot.querySelector('[data-save]');
    const submit = () => withBusy(save, async () => {
        const error = body.querySelector('[data-error]');
        error.textContent = '';
        try {
            const name = body.querySelector('#pf-name').value.trim();
            if (!name) throw new Error('نام پروفایل را وارد کنید');
            const payload = preset || await readBackupFile(file);
            const result = await api.post('/api/profiles', { name, payload: payload || undefined, open: false });
            await store.switchProfile(result.created);
            await store.refreshProfiles();
            notify.success(`پروفایل «${name}» ساخته شد`);
            instance.close(true);
        } catch (failure) {
            error.textContent = failure.message;
        }
    });
    save.addEventListener('click', submit);
    body.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        save.click();
    });
}

export function openRename(profile) {
    const instance = openDialog({
        title: 'تغییر نام پروفایل',
        size: 'sm',
        body: html`<div class="field"><label for="pf-rename">نام پروفایل</label><input id="pf-rename" class="input" maxlength="${MAX_NAME}" value="${profile.name}"></div>
            <div class="field-error" data-error role="alert"></div>`,
        footer: html`<button type="button" class="btn btn-ghost" data-close>انصراف</button>
            <button type="button" class="btn btn-primary" data-save>${icon('check')}<span>ذخیره</span></button>`,
    });
    const input = instance.body.querySelector('#pf-rename');
    input.focus();
    input.select();
    const save = instance.foot.querySelector('[data-save]');
    save.addEventListener('click', () => withBusy(save, async () => {
        try {
            await api.put(`/api/profiles/${encodeURIComponent(profile.id)}`, { name: input.value });
            await store.refreshProfiles();
            instance.close(true);
        } catch (failure) {
            instance.body.querySelector('[data-error]').textContent = failure.message;
        }
    }));
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save.click();
    });
}

async function removeProfile(profile) {
    const confirmed = await confirmDialog({
        title: 'حذف پروفایل',
        message: `پروفایل «${profile.name}» با همهٔ دارایی‌ها، تراکنش‌ها و تنظیمات آن برای همیشه حذف می‌شود. اگر فایل پشتیبان ندارید، ابتدا از آن پشتیبان بگیرید. ادامه می‌دهید؟`,
        confirmText: 'حذف شود',
        danger: true,
    });
    if (!confirmed) return false;
    const wasActive = profile.id === store.activeProfile;
    if (wasActive && !IS_LOCAL) setServerProfile('');
    await api.del(`/api/profiles/${encodeURIComponent(profile.id)}`);
    await store.refreshProfiles();
    if (wasActive) await reopen();
    return true;
}

export function openManageProfiles() {
    const instance = openDialog({ title: 'مدیریت پروفایل‌ها', body: '', footer: html`<button type="button" class="btn btn-secondary" data-add>${icon('plus')}<span>پروفایل جدید</span></button>
        <span class="grow"></span><button type="button" class="btn btn-primary" data-close>بستن</button>` });

    function render() {
        const list = store.profiles;
        setHtml(instance.body, html`
            <p class="field-hint" style="margin-top:0">نام هر پروفایل را تغییر دهید، ترتیب تب‌ها را مشخص کنید یا پروفایلی را حذف کنید.</p>
            <ul class="profile-manage">
                ${list.map((profile, index) => html`
                    <li data-id="${profile.id}">
                        <span class="avatar-dot">${icon('user-round', 'icon-sm')}</span>
                        <span class="grow">
                            <strong>${profile.name}</strong>
                            ${profile.id === store.activeProfile ? html`<span class="badge">باز</span>` : ''}
                        </span>
                        <button type="button" class="icon-btn plain icon-btn-sm" data-up="${profile.id}" aria-label="انتقال به قبل" ${index === 0 ? html`disabled` : ''}>${icon('chevron-up', 'icon-sm')}</button>
                        <button type="button" class="icon-btn plain icon-btn-sm" data-down="${profile.id}" aria-label="انتقال به بعد" ${index === list.length - 1 ? html`disabled` : ''}>${icon('chevron-down', 'icon-sm')}</button>
                        <button type="button" class="icon-btn plain icon-btn-sm" data-rename="${profile.id}" aria-label="تغییر نام" title="تغییر نام">${icon('pencil', 'icon-sm')}</button>
                        <button type="button" class="icon-btn plain icon-btn-sm" data-remove="${profile.id}" aria-label="حذف" title="حذف" ${list.length < 2 || (!IS_LOCAL && profile.main) ? html`disabled` : ''}>${icon('trash-2', 'icon-sm')}</button>
                    </li>`)}
            </ul>`);
    }

    async function move(id, delta) {
        const ids = store.profiles.map((profile) => profile.id);
        const index = ids.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        try {
            await api.put('/api/profiles-order', { ids });
            await store.refreshProfiles();
        } catch (failure) {
            notify.error(failure.message);
        }
    }

    instance.dialog.addEventListener('click', async (event) => {
        const find = (attribute) => {
            const element = event.target.closest(`[${attribute}]`);
            return element ? store.profiles.find((profile) => profile.id === element.getAttribute(attribute)) : null;
        };
        if (event.target.closest('[data-add]')) openAddProfile();
        const up = find('data-up');
        if (up) await move(up.id, -1);
        const down = find('data-down');
        if (down) await move(down.id, 1);
        const rename = find('data-rename');
        if (rename) openRename(rename);
        const remove = find('data-remove');
        if (remove) {
            try {
                await removeProfile(remove);
            } catch (failure) {
                notify.error(failure.message);
            }
        }
    });
    const off = store.on('profiles', render);
    const originalClose = instance.close;
    instance.close = (result) => {
        off();
        originalClose(result);
    };
    render();
}

/** Draws the tabs into `host` and keeps them in step with the profile list. */
export function mountProfileTabs(host) {
    let switching = false;

    function render() {
        setHtml(host, html`
            <div class="profile-tabs" role="tablist" aria-label="پروفایل‌ها">
                ${store.profiles.map((profile) => html`
                    <button type="button" role="tab" class="profile-tab" data-profile="${profile.id}" aria-selected="${profile.id === store.activeProfile}"
                        tabindex="${profile.id === store.activeProfile ? 0 : -1}" title="${profile.name} (برای تغییر نام دو بار کلیک کنید)">
                        ${icon('user-round', 'icon-sm')}<span>${profile.name}</span>
                    </button>`)}
            </div>
            <button type="button" class="profile-action" data-add title="افزودن پروفایل جدید">${icon('plus', 'icon-sm')}<span>پروفایل جدید</span></button>
            <button type="button" class="icon-btn plain icon-btn-sm" data-manage aria-label="مدیریت پروفایل‌ها" title="مدیریت پروفایل‌ها">${icon('settings', 'icon-sm')}</button>`);
        const active = host.querySelector('[aria-selected="true"]');
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    async function choose(id) {
        if (switching || id === store.activeProfile) return;
        switching = true;
        host.classList.add('is-switching');
        try {
            await store.switchProfile(id);
        } catch (failure) {
            notify.error(failure.message);
        } finally {
            switching = false;
            host.classList.remove('is-switching');
            render();
        }
    }

    host.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-profile]');
        if (tab) {
            choose(tab.dataset.profile);
            return;
        }
        if (event.target.closest('[data-add]')) openAddProfile();
        if (event.target.closest('[data-manage]')) openManageProfiles();
    });
    host.addEventListener('dblclick', (event) => {
        const tab = event.target.closest('[data-profile]');
        const profile = tab && store.profiles.find((item) => item.id === tab.dataset.profile);
        if (profile) openRename(profile);
    });
    host.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const tabs = [...host.querySelectorAll('[data-profile]')];
        const index = tabs.indexOf(document.activeElement);
        if (index < 0) return;
        const step = (getComputedStyle(host).direction === 'rtl' ? -1 : 1) * (event.key === 'ArrowRight' ? 1 : -1);
        const next = tabs[(index + step + tabs.length) % tabs.length];
        next.focus();
        choose(next.dataset.profile);
    });

    store.on('profiles', render);
    store.on('profile', render);
    render();
}
