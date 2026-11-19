import { api, IS_LOCAL } from '../api.js';
import { downloadExport } from '../download.js';
import { store } from '../state.js';
import { html, icon, setHtml } from '../lib/dom.js';
import { relativeTime, number, faDigits, providerLabel } from '../format.js';
import { themeMode, setThemeMode } from '../ui/theme.js';
import { confirmDialog, withBusy } from '../ui/dialog.js';
import { notify } from '../ui/toast.js';
import { RANGES } from './dashboard.js';
import { mountLockSettings } from '../plus/lock-ui.js';
import { openManageProfiles, openAddProfile } from '../plus/profile-tabs.js';
import { backupKind } from '../shared/plus/backup.js';

const INTERVALS = [
    [15, '۱۵ دقیقه'],
    [30, '۳۰ دقیقه (پیشنهادی)'],
    [60, '۱ ساعت'],
    [180, '۳ ساعت'],
    [360, '۶ ساعت'],
    [720, '۱۲ ساعت'],
    [1440, '۲۴ ساعت'],
];

const PROVIDER_NOTES = {
    'iran-market': 'رایگان و بدون ثبت‌نام · پیش‌فرض',
    navasan: 'نیازمند کلید API · ارز، طلا و سکه',
};

/** How this copy of the app is running, for the About section. */
function runtimeLabel() {
    if (!IS_LOCAL) return 'نسخه سرور';
    const capacitor = window.Capacitor;
    if (capacitor && capacitor.isNativePlatform && capacitor.isNativePlatform()) return 'اپلیکیشن موبایل (داده روی همین گوشی)';
    if (/Electron/.test(navigator.userAgent)) return 'نسخه دسکتاپ (داده روی همین کامپیوتر)';
    return 'نسخه وب (داده روی همین مرورگر)';
}

function segmented(name, options, value) {
    return html`<div class="segmented" role="group" data-segment="${name}">
        ${options.map(([key, label]) => html`<button type="button" data-value="${key}" aria-pressed="${String(key) === String(value)}">${label}</button>`)}
    </div>`;
}

/** Stock prices come from the Tehran Stock Exchange, separately from the main price source. */
function stockStatus(status) {
    const stocks = status && status.stocks;
    if (!stocks || !stocks.count) return '';
    const failed = stocks.ok === false;
    return html`
        <div class="alert ${failed ? 'error' : 'info'}" style="margin:0">
            ${icon(failed ? 'circle-alert' : 'chart-column')}
            <div class="grow">
                <strong>سهام بورس تهران:</strong> ${number(stocks.count)} نماد ·
                ${failed ? stocks.error : `آخرین به‌روزرسانی ${stocks.lastSuccessAt ? relativeTime(stocks.lastSuccessAt) : 'هنوز انجام نشده'}`}
            </div>
        </div>`;
}

function statusBlock(status) {
    if (!status) return '';
    const failed = status.ok === false;
    return html`
        <div class="alert ${failed ? 'error' : 'info'}" style="margin:0">
            ${icon(failed ? 'circle-alert' : 'circle-check')}
            <div class="grow">
                ${failed ? html`<strong>آخرین تلاش ناموفق بود:</strong> ${status.error}<br>` : ''}
                <span class="small">
                    آخرین دریافت موفق: ${status.lastSuccessAt ? relativeTime(status.lastSuccessAt) : 'هنوز انجام نشده'}
                    ${status.publishedAt ? ` · انتشار داده: ${relativeTime(status.publishedAt)}` : ''}
                    ${status.quoteCount ? ` · ${number(status.quoteCount)} قیمت` : ''}
                    ${status.nextRunAt ? ` · به‌روزرسانی بعدی: ${relativeTime(status.nextRunAt)}` : ''}
                </span>
            </div>
        </div>`;
}

export function mount({ view, setTitle }) {
    setTitle('تنظیمات');
    let alive = true;
    const prefs = store.preferences;
    const draft = {
        provider: prefs.provider,
        mirror: prefs.iranMarket.mirror,
        customUrl: prefs.iranMarket.customUrl || '',
        refreshMinutes: prefs.refreshMinutes,
    };

    function sourceFields() {
        if (draft.provider === 'navasan') {
            const { hasKey, keyHint } = store.preferences.navasan;
            return html`
                <div class="field">
                    <label for="navasan-key">کلید API نوسان</label>
                    <div class="input-group">
                        <input id="navasan-key" class="input ltr" type="password" autocomplete="off" spellcheck="false"
                            placeholder="${hasKey ? `کلید فعلی: ${keyHint}` : 'کلید را وارد کنید'}">
                        <button type="button" class="icon-btn plain icon-btn-sm addon-btn" data-reveal aria-label="نمایش کلید">${icon('eye', 'icon-sm')}</button>
                    </div>
                    <span class="field-hint">${hasKey ? 'برای تغییر، کلید جدید را وارد کنید؛ خالی بگذارید تا کلید فعلی حفظ شود.' : 'کلید را از ربات تلگرام نوسان یا سایت navasan.tech بگیرید.'}
                        پلن رایگان نوسان فقط ۱۲۰ درخواست در ماه دارد؛ بازه به‌روزرسانی را ۱۲ یا ۲۴ ساعت بگذارید.</span>
                </div>`;
        }
        return html`
            <div class="field">
                <label for="mirror">آدرس دریافت داده</label>
                <select id="mirror" class="select" data-mirror>
                    <option value="github" ${draft.mirror === 'github' ? html`selected` : ''}>GitHub (پیشنهادی، تازه‌ترین داده)</option>
                    <option value="jsdelivr" ${draft.mirror === 'jsdelivr' ? html`selected` : ''}>jsDelivr CDN (اگر GitHub در دسترس نیست)</option>
                    <option value="custom" ${draft.mirror === 'custom' ? html`selected` : ''}>آدرس اختصاصی (آینه شخصی)</option>
                </select>
                <span class="field-hint">اگر یک آدرس در دسترس نباشد، دلاربان خودکار سراغ آدرس‌های دیگر می‌رود.</span>
            </div>
            <div class="field" ${draft.mirror === 'custom' ? '' : html`hidden`} data-custom-url-field>
                <label for="custom-url">آدرس پوشه data</label>
                <input id="custom-url" class="input ltr" type="url" dir="ltr" value="${draft.customUrl}" placeholder="https://example.com/iran-market/data">
            </div>`;
    }

    let lockCleanup = null;

    function mountExtras() {
        if (lockCleanup) lockCleanup();
        lockCleanup = null;
        const host = view.querySelector('[data-lock-section]');
        if (host) lockCleanup = mountLockSettings(host);
    }

    function render() {
        renderSections();
        mountExtras();
    }

    function renderSections() {
        const current = store.preferences;
        setHtml(view, html`
            <div class="settings">
                <section class="card settings-section" id="source">
                    <header>
                        <h2>منبع قیمت‌ها</h2>
                        <p>${IS_LOCAL
                            ? 'قیمت ارز، طلا، سکه و رمزارز مستقیماً از Iran Market دریافت می‌شود؛ رایگان و بدون نیاز به کلید.'
                            : 'Iran Market رایگان است، کلید نمی‌خواهد و قیمت ارز، طلا، سکه و رمزارز را هر ۳۰ دقیقه منتشر می‌کند. در صورت تمایل می‌توانید از نوسان استفاده کنید.'}</p>
                    </header>
                    <div class="settings-body">
                        ${store.providers.length > 1 ? html`
                        <div class="radio-cards" role="radiogroup" aria-label="منبع قیمت">
                            ${store.providers.map((provider) => html`
                            <label class="radio-card">
                                <input type="radio" name="provider" value="${provider.id}" ${draft.provider === provider.id ? html`checked` : ''}>
                                <span class="radio-mark"></span>
                                <span><strong>${providerLabel(provider)}</strong><p>${PROVIDER_NOTES[provider.id] || ''}</p></span>
                            </label>`)}
                        </div>` : ''}
                        <div data-source-fields>${sourceFields()}</div>
                        <div class="field">
                            <label for="refresh">به‌روزرسانی خودکار قیمت‌ها هر</label>
                            <select id="refresh" class="select" data-refresh>
                                ${INTERVALS.map(([minutes, label]) => html`<option value="${minutes}" ${minutes === draft.refreshMinutes ? html`selected` : ''}>${label}</option>`)}
                                ${INTERVALS.some(([minutes]) => minutes === draft.refreshMinutes) ? '' : html`<option value="${draft.refreshMinutes}" selected>${faDigits(draft.refreshMinutes)} دقیقه</option>`}
                            </select>
                        </div>
                        <div class="settings-actions">
                            <button type="button" class="btn btn-primary" data-save-source>${icon('check')}<span>ذخیره منبع داده</span></button>
                            <button type="button" class="btn btn-secondary" data-test>${icon('activity')}<span>آزمایش اتصال</span></button>
                            <span class="test-result" data-test-result aria-live="polite"></span>
                        </div>
                        <div data-status>${statusBlock(store.status)}</div>
                        ${stockStatus(store.status)}
                    </div>
                </section>

                <section class="card settings-section" id="display">
                    <header>
                        <h2>نمایش</h2>
                        <p>واحد پول و ظاهر برنامه. پوسته روی همین دستگاه ذخیره می‌شود.</p>
                    </header>
                    <div class="settings-body">
                        <div class="field"><span class="field-label">واحد نمایش مبالغ</span>${segmented('unit', [['toman', 'تومان'], ['rial', 'ریال']], current.displayUnit)}</div>
                        <div class="field"><span class="field-label">پوسته</span>${segmented('theme', [['system', 'هماهنگ با سیستم'], ['light', 'روشن'], ['dark', 'تیره']], themeMode())}</div>
                        <div class="field"><span class="field-label">بازه پیش‌فرض نمودارها</span>${segmented('range', RANGES, current.chartRange)}</div>
                    </div>
                </section>

                <section class="card settings-section" id="watchlist">
                    <header>
                        <h2>دیده‌بان بازار</h2>
                        <p>دارایی‌هایی که قیمتشان در داشبورد نمایش داده می‌شود. از صفحه بازار با ستاره اضافه کنید.</p>
                    </header>
                    <div class="settings-body">
                        <div class="watch-list-edit">
                            ${current.watchlist.length ? current.watchlist.map((symbol) => {
                                const asset = store.asset(symbol);
                                return html`<span class="chip">${asset ? asset.name : symbol}
                                    <button type="button" data-unwatch="${symbol}" aria-label="${`حذف ${asset ? asset.name : symbol}`}">${icon('x', 'icon-sm')}</button></span>`;
                            }) : html`<span class="muted small">فهرست دیده‌بان خالی است.</span>`}
                        </div>
                        <div><a class="btn btn-secondary btn-sm" href="#/market">${icon('star', 'icon-sm')}<span>افزودن از بازار</span></a></div>
                    </div>
                </section>

                ${IS_LOCAL ? html`
                <section class="card settings-section" id="device">
                    <header>
                        <h2>داده‌های این دستگاه</h2>
                        <p>تراکنش‌ها و تنظیمات فقط روی همین دستگاه ذخیره می‌شوند و به هیچ سروری فرستاده نمی‌شوند. برای جلوگیری از گم شدن داده، هر چند وقت یک بار فایل پشتیبان بگیرید.</p>
                    </header>
                    <div class="settings-body">
                        <div class="settings-actions">
                            <button type="button" class="btn btn-danger-ghost" data-reset-local>${icon('trash-2')}<span>پاک کردن همه داده‌های این دستگاه</span></button>
                        </div>
                    </div>
                </section>` : html`
                <section class="card settings-section" id="security">
                    <header>
                        <h2>امنیت</h2>
                        <p>نام کاربری: <strong class="ltr">${store.username}</strong>. با تغییر رمز، سایر نشست‌ها خارج می‌شوند.</p>
                    </header>
                    <div class="settings-body">
                        ${store.defaultPassword ? html`<div class="alert warn" style="margin:0">${icon('triangle-alert')}<div class="grow">رمز پیش‌فرض «changeit» هنوز فعال است.</div></div>` : ''}
                        <form class="form-grid" data-password autocomplete="on">
                            <input type="text" name="username" autocomplete="username" value="${store.username}" hidden>
                            <div class="field full"><label for="pw-current">رمز فعلی</label>
                                <input id="pw-current" class="input" type="password" autocomplete="current-password" required></div>
                            <div class="field"><label for="pw-next">رمز جدید</label>
                                <input id="pw-next" class="input" type="password" autocomplete="new-password" minlength="8" required></div>
                            <div class="field"><label for="pw-confirm">تکرار رمز جدید</label>
                                <input id="pw-confirm" class="input" type="password" autocomplete="new-password" minlength="8" required></div>
                            <div class="full settings-actions">
                                <button type="submit" class="btn btn-primary">${icon('key-round')}<span>تغییر رمز</span></button>
                                <button type="button" class="btn btn-ghost" data-logout-others>${icon('log-out')}<span>خروج از سایر دستگاه‌ها</span></button>
                            </div>
                        </form>
                    </div>
                </section>`}

                <section class="card settings-section" id="profiles">
                    <header>
                        <h2>پروفایل‌ها</h2>
                        <p>هر پروفایل محیط کاملاً جداگانه‌ای با دارایی‌ها، تراکنش‌ها، پول نقد و تنظیمات خودش است. تب‌های بالای برنامه پروفایل‌ها را نشان می‌دهند.</p>
                    </header>
                    <div class="settings-body">
                        <div class="chips">${store.profiles.map((profile) => html`<span class="chip" aria-pressed="${profile.id === store.activeProfile}">${profile.name}</span>`)}</div>
                        <div class="settings-actions">
                            <button type="button" class="btn btn-secondary" data-manage-profiles>${icon('users-round')}<span>مدیریت پروفایل‌ها</span></button>
                            <button type="button" class="btn btn-ghost" data-add-profile>${icon('plus')}<span>پروفایل جدید</span></button>
                        </div>
                    </div>
                </section>

                ${IS_LOCAL ? html`<section class="card settings-section" id="lock" data-lock-section></section>` : ''}

                <section class="card settings-section" id="backup">
                    <header>
                        <h2>پشتیبان‌گیری و بازیابی</h2>
                        <p>از هر پروفایل جداگانه پشتیبان بگیرید یا از همهٔ پروفایل‌ها و تنظیمات برنامه یک فایل کامل بسازید. فایل پشتیبان نسخهٔ اصلی دلاربان را هم می‌توانید در هر پروفایل بازیابی کنید.</p>
                    </header>
                    <div class="settings-body">
                        <h3 class="settings-sub">پشتیبان یک پروفایل</h3>
                        <div class="field">
                            <label for="backup-profile">پروفایل</label>
                            <select id="backup-profile" class="select" data-backup-profile>
                                ${store.profiles.map((profile) => html`<option value="${profile.id}" ${profile.id === store.activeProfile ? html`selected` : ''}>${profile.name}</option>`)}
                            </select>
                        </div>
                        <div class="settings-actions">
                            <button type="button" class="btn btn-secondary" data-profile-export="/api/export">${icon('download')}<span>دانلود پشتیبان پروفایل</span></button>
                            <button type="button" class="btn btn-secondary" data-profile-export="/api/export.csv">${icon('file-spreadsheet')}<span>خروجی اکسل تراکنش‌ها</span></button>
                        </div>
                        <div class="field">
                            <label for="restore-profile">بازگردانی از فایل در</label>
                            <select id="restore-profile" class="select" data-restore-profile>
                                ${store.profiles.map((profile) => html`<option value="${profile.id}" ${profile.id === store.activeProfile ? html`selected` : ''}>${profile.name}</option>`)}
                                <option value="__new__">پروفایل جدید…</option>
                            </select>
                            <div class="settings-actions">
                                <label class="btn btn-secondary">${icon('upload')}<span>انتخاب فایل…</span>
                                    <input type="file" class="sr-only" accept="application/json,.json" data-import></label>
                                <label class="check"><input type="checkbox" data-replace>جایگزینی کامل اطلاعات پروفایل</label>
                            </div>
                            <span class="field-hint">در حالت عادی، اطلاعات فایل با پروفایل انتخاب‌شده ادغام می‌شود و موارد تکراری دوباره ثبت نمی‌شوند.</span>
                        </div>

                        <h3 class="settings-sub">پشتیبان کامل (همهٔ پروفایل‌ها و تنظیمات)</h3>
                        <div class="settings-actions">
                            <button type="button" class="btn btn-primary" data-full-export>${icon('database')}<span>دانلود پشتیبان کامل</span></button>
                            <label class="btn btn-secondary">${icon('upload')}<span>بازیابی پشتیبان کامل…</span>
                                <input type="file" class="sr-only" accept="application/json,.json" data-import-full></label>
                            <label class="check"><input type="checkbox" data-replace-full>جایگزینی کامل (پروفایل‌های دیگر حذف می‌شوند)</label>
                        </div>
                        <span class="field-hint">پشتیبان کامل شامل همهٔ پروفایل‌ها، دارایی‌ها، تراکنش‌ها، پول نقد، سهام، برداشت‌ها، تنظیمات و ظاهر برنامه است. رمز قفل برنامه در آن ذخیره نمی‌شود. اگر کلید API نوسان را وارد کرده باشید در فایل قرار می‌گیرد؛ فایل را امن نگه دارید.</span>
                    </div>
                </section>

                <section class="card settings-section" id="about">
                    <header><h2>درباره دلاربان پلاس</h2></header>
                    <div class="settings-body">
                        <dl class="kv">
                            <dt>نسخه</dt><dd><span class="ltr">${store.version}</span> · ${runtimeLabel()}</dd>
                            <dt>کد منبع</dt><dd><a href="https://github.com/farshad-zamani/DollarBaan-Plus" target="_blank" rel="noopener">github.com/farshad-zamani/DollarBaan-Plus</a></dd>
                            <dt>بر پایهٔ</dt><dd><a href="https://github.com/MahdiGraph/DollarBaan" target="_blank" rel="noopener">دلاربان</a> <span class="muted">اثر MahdiGraph، با مجوز MIT</span></dd>
                            <dt>ارتقا و توسعه</dt><dd><a href="https://cloudtart.com" target="_blank" rel="noopener"><strong>کلادتارت - <bdi dir="ltr">www.CloudTart.com</bdi></strong></a></dd>
                            <dt>داده بازار</dt><dd><a href="https://github.com/iran-market/iran-market.github.io" target="_blank" rel="noopener">ایران مارکت</a> <span class="muted">(ارز، طلا، سکه و رمزارز)</span> · بورس تهران برای سهام</dd>
                        </dl>
                        <p class="small muted">قیمت‌ها صرفاً برای اطلاع‌رسانی هستند و توصیه خرید یا فروش محسوب نمی‌شوند.</p>
                    </div>
                </section>
            </div>`);
    }

    function setSegment(name, value) {
        const group = view.querySelector(`[data-segment="${name}"]`);
        if (!group) return;
        for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === String(value)));
    }

    function sourcePayload() {
        const payload = { provider: draft.provider, refreshMinutes: draft.refreshMinutes };
        if (draft.provider === 'iran-market') {
            payload.iranMarket = { mirror: draft.mirror, customUrl: draft.customUrl.trim() };
        } else {
            const key = view.querySelector('#navasan-key');
            if (key && key.value.trim()) payload.navasan = { apiKey: key.value.trim() };
        }
        return payload;
    }

    async function saveSource(button) {
        await withBusy(button, async () => {
            try {
                await store.savePreferences(sourcePayload());
                notify.success('تنظیمات منبع داده ذخیره شد');
                const key = view.querySelector('#navasan-key');
                if (key) key.value = '';
                setTimeout(() => store.refreshStatus().catch(() => {}), 2500);
            } catch (error) {
                notify.error(error.message);
            }
        });
    }

    async function testSource(button) {
        const result = view.querySelector('[data-test-result]');
        result.textContent = '';
        await withBusy(button, async () => {
            try {
                const outcome = await api.post('/api/settings/test-provider', sourcePayload());
                setHtml(result, outcome.ok
                    ? html`<span class="pos with-icon">${icon('circle-check', 'icon-sm')}اتصال برقرار است${outcome.publishedAt ? ` (آخرین انتشار ${relativeTime(outcome.publishedAt)})` : ''}</span>`
                    : html`<span class="neg">${outcome.error}</span>`);
            } catch (error) {
                setHtml(result, html`<span class="neg">${error.message}</span>`);
            }
        });
    }

    async function changePassword(form) {
        const current = form.querySelector('#pw-current').value;
        const next = form.querySelector('#pw-next').value;
        const confirm = form.querySelector('#pw-confirm').value;
        if (next !== confirm) {
            notify.error('تکرار رمز جدید با آن یکسان نیست');
            return;
        }
        const button = form.querySelector('button[type="submit"]');
        await withBusy(button, async () => {
            try {
                await api.post('/api/account/password', { current, next });
                form.reset();
                store.defaultPassword = false;
                store.emit('account');
                notify.success('رمز عبور تغییر کرد');
                render();
            } catch (error) {
                notify.error(error.message);
            }
        });
    }

    async function readJson(input) {
        const chosen = input.files && input.files[0];
        input.value = '';
        if (!chosen) return null;
        try {
            return JSON.parse(await chosen.text());
        } catch {
            notify.error('فایل انتخاب‌شده JSON معتبر نیست');
            return null;
        }
    }

    async function afterRestore() {
        store.reset();
        await store.bootstrap();
        await store.refreshProfiles();
        store.emit('profile', store.activeProfile);
    }

    async function importFile(input) {
        const payload = await readJson(input);
        if (!payload) return;
        const kind = backupKind(payload);
        if (kind === 'plus-full') {
            notify.error('این فایل پشتیبان کامل همه پروفایل‌هاست؛ آن را با «بازیابی پشتیبان کامل» بازیابی کنید');
            return;
        }
        if (!kind) {
            notify.error('این فایل پشتیبان دلاربان یا دلاربان پلاس نیست');
            return;
        }
        const replace = view.querySelector('[data-replace]').checked;
        const target = view.querySelector('[data-restore-profile]').value;
        const customCount = Array.isArray(payload.customAssets) ? payload.customAssets.length : 0;
        const where = target === '__new__' ? 'یک پروفایل جدید' : `پروفایل «${(store.profiles.find((item) => item.id === target) || {}).name}»`;
        const confirmed = await confirmDialog({
            title: 'بازگردانی پشتیبان',
            message: `${number(payload.transactions.length)} تراکنش و ${number(customCount)} دارایی دستی ${kind === 'original' ? '(فایل نسخهٔ اصلی دلاربان) ' : ''}در ${where} ${replace && target !== '__new__' ? 'جایگزین اطلاعات فعلی می‌شود' : 'بازگردانی می‌شود'}. ادامه می‌دهید؟`,
            confirmText: 'بازگردانی',
            danger: replace && target !== '__new__',
        });
        if (!confirmed) return;
        try {
            if (target === '__new__') {
                const suggested = payload.profile && payload.profile.name ? payload.profile.name : 'پروفایل بازیابی‌شده';
                openAddProfileFromFile(payload, suggested);
                return;
            }
            const result = await api.post(`/api/import?profile=${encodeURIComponent(target)}${replace ? '&mode=replace' : ''}`, payload);
            notify.success(`${number(result.transactions)} تراکنش بازگردانی شد`);
            if (target === store.activeProfile) {
                await store.loadAssets({ force: true });
                await store.bootstrap();
                store.dataChanged();
                render();
            }
        } catch (error) {
            notify.error(error.message);
        }
    }

    /** Restoring into a new profile asks for its name first. */
    function openAddProfileFromFile(payload, suggestedName) {
        openAddProfile({ payload, name: suggestedName });
    }

    async function importFull(input) {
        const payload = await readJson(input);
        if (!payload) return;
        if (backupKind(payload) !== 'plus-full') {
            notify.error('این فایل، پشتیبان کامل دلاربان پلاس نیست؛ پشتیبان یک پروفایل را از بخش بالاتر بازیابی کنید');
            return;
        }
        const replace = view.querySelector('[data-replace-full]').checked;
        const confirmed = await confirmDialog({
            title: 'بازیابی پشتیبان کامل',
            message: `${number(payload.profiles.length)} پروفایل ${replace ? 'جایگزین همهٔ پروفایل‌های فعلی می‌شود (پروفایل‌هایی که در فایل نیستند حذف می‌شوند)' : 'با پروفایل‌های فعلی ادغام می‌شود'}. ادامه می‌دهید؟`,
            confirmText: 'بازیابی',
            danger: replace,
        });
        if (!confirmed) return;
        try {
            const result = await api.post(`/api/backup/full${replace ? '?mode=replace' : ''}`, payload);
            if (result.appSettings && (result.appSettings.theme === 'light' || result.appSettings.theme === 'dark')) setThemeMode(result.appSettings.theme);
            await afterRestore();
            notify.success(`${number(result.profiles)} پروفایل بازیابی شد`);
        } catch (error) {
            notify.error(error.message);
        }
    }

    const onClick = async (event) => {
        const segmentButton = event.target.closest('[data-segment] button');
        if (segmentButton) {
            const name = segmentButton.closest('[data-segment]').dataset.segment;
            const value = segmentButton.dataset.value;
            setSegment(name, value);
            try {
                if (name === 'theme') setThemeMode(value);
                if (name === 'unit') {
                    await store.savePreferences({ displayUnit: value });
                    notify.success(value === 'rial' ? 'مبالغ به ریال نمایش داده می‌شوند' : 'مبالغ به تومان نمایش داده می‌شوند');
                }
                if (name === 'range') await store.savePreferences({ chartRange: value });
            } catch (error) {
                notify.error(error.message);
            }
            return;
        }
        if (event.target.closest('[data-manage-profiles]')) {
            openManageProfiles();
            return;
        }
        if (event.target.closest('[data-add-profile]')) {
            openAddProfile();
            return;
        }
        const profileExport = event.target.closest('[data-profile-export]');
        if (profileExport) {
            const id = view.querySelector('[data-backup-profile]').value;
            try {
                await downloadExport(`${profileExport.dataset.profileExport}?profile=${encodeURIComponent(id)}`);
            } catch (error) {
                notify.error(error.message || 'ساخت فایل ناموفق بود');
            }
            return;
        }
        if (event.target.closest('[data-full-export]')) {
            try {
                await downloadExport('/api/backup/full');
            } catch (error) {
                notify.error(error.message || 'ساخت فایل ناموفق بود');
            }
            return;
        }
        const download = event.target.closest('[data-download]');
        if (download) {
            try {
                await downloadExport(download.dataset.download);
            } catch (error) {
                notify.error(error.message || 'ساخت فایل ناموفق بود');
            }
            return;
        }
        if (event.target.closest('[data-reset-local]')) {
            const confirmed = await confirmDialog({
                title: 'پاک کردن همه داده‌ها',
                message: 'همه تراکنش‌ها، دارایی‌های دستی و تنظیمات این دستگاه برای همیشه پاک می‌شوند. اگر فایل پشتیبان ندارید، اول آن را دانلود کنید.',
                confirmText: 'همه پاک شود',
                danger: true,
            });
            if (!confirmed) return;
            try {
                await api.post('/api/local/reset');
                window.location.reload();
            } catch (error) {
                notify.error(error.message);
            }
            return;
        }
        const unwatch = event.target.closest('[data-unwatch]');
        if (unwatch) {
            try {
                await store.toggleWatch(unwatch.dataset.unwatch);
                render();
            } catch (error) {
                notify.error(error.message);
            }
            return;
        }
        const save = event.target.closest('[data-save-source]');
        if (save) {
            saveSource(save);
            return;
        }
        const test = event.target.closest('[data-test]');
        if (test) {
            testSource(test);
            return;
        }
        const reveal = event.target.closest('[data-reveal]');
        if (reveal) {
            const input = view.querySelector('#navasan-key');
            const visible = input.type === 'text';
            input.type = visible ? 'password' : 'text';
            setHtml(reveal, icon(visible ? 'eye' : 'eye-off', 'icon-sm'));
            return;
        }
        if (event.target.closest('[data-logout-others]')) {
            try {
                const result = await api.post('/api/account/logout-others');
                notify.success(result.removed ? `${number(result.removed)} نشست دیگر بسته شد` : 'نشست فعال دیگری وجود نداشت');
            } catch (error) {
                notify.error(error.message);
            }
        }
    };

    const onChange = (event) => {
        const target = event.target;
        if (target.name === 'provider') {
            draft.provider = target.value;
            setHtml(view.querySelector('[data-source-fields]'), sourceFields());
            if (draft.provider === 'navasan' && draft.refreshMinutes < 720) {
                draft.refreshMinutes = 1440;
                view.querySelector('[data-refresh]').value = '1440';
            }
        } else if (target.matches('[data-mirror]')) {
            draft.mirror = target.value;
            view.querySelector('[data-custom-url-field]').hidden = draft.mirror !== 'custom';
        } else if (target.matches('[data-refresh]')) {
            draft.refreshMinutes = Number(target.value);
        } else if (target.matches('[data-import]')) {
            importFile(target);
        } else if (target.matches('[data-import-full]')) {
            importFull(target);
        }
    };

    const onInput = (event) => {
        if (event.target.id === 'custom-url') draft.customUrl = event.target.value;
    };

    const onSubmit = (event) => {
        if (event.target.matches('[data-password]')) {
            event.preventDefault();
            changePassword(event.target);
        }
    };

    view.addEventListener('click', onClick);
    view.addEventListener('change', onChange);
    view.addEventListener('input', onInput);
    view.addEventListener('submit', onSubmit);

    const unsubscribe = [
        store.on('status', (status) => {
            const target = view.querySelector('[data-status]');
            if (target) setHtml(target, statusBlock(status));
        }),
    ];

    store.loadAssets().then(() => alive && render()).catch(() => alive && render());
    render();

    return {
        unmount() {
            alive = false;
            if (lockCleanup) lockCleanup();
            view.removeEventListener('click', onClick);
            view.removeEventListener('change', onChange);
            view.removeEventListener('input', onInput);
            view.removeEventListener('submit', onSubmit);
            unsubscribe.forEach((off) => off());
        },
    };
}
