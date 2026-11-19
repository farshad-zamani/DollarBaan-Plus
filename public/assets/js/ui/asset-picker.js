import { html, icon, setHtml } from '../lib/dom.js';
import { store } from '../state.js';
import { CATEGORY_LABELS, money, searchKey } from '../format.js';
import { avatar, assetSub } from './asset-visuals.js';
import { api } from '../api.js';
import { notify } from './toast.js';

const MAX_RESULTS = 150;
let uid = 0;

function matches(asset, tokens) {
    if (!tokens.length) return true;
    const haystack = searchKey(`${asset.name} ${asset.nameEn || ''} ${asset.symbol.replace(/_/g, ' ')}`);
    return tokens.every((token) => haystack.includes(token));
}

/**
 * Searchable asset selector that expands inline (works inside dialogs and on phones).
 */
export function createAssetPicker(container, { value = null, onChange, onCreateCustom, onCreateCash, heldFirst = false, exclude = [] } = {}) {
    uid += 1;
    const listId = `picker-list-${uid}`;
    let selected = value;
    let query = '';
    let category = 'all';
    let active = -1;
    let rendered = [];

    setHtml(container, html`
        <button type="button" class="picker-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${listId}"></button>
        <div class="picker-panel" hidden>
            <div class="picker-search">
                <label class="search-input">
                    ${icon('search')}
                    <input class="input" type="search" placeholder="جستجوی نام یا نماد…" aria-label="جستجوی دارایی"
                        autocomplete="off" role="combobox" aria-controls="${listId}" aria-expanded="true">
                </label>
                <div class="chips" role="group" aria-label="دسته‌بندی"></div>
            </div>
            <div class="picker-list" id="${listId}" role="listbox" aria-label="فهرست دارایی‌ها"></div>
            ${onCreateCustom || onCreateCash ? html`<div class="picker-foot">
                ${onCreateCustom ? html`<button type="button" class="btn btn-ghost btn-sm btn-block" data-create>${icon('plus', 'icon-sm')}<span>تعریف دارایی دستی (ملک، خودرو، سپرده…)</span></button>` : ''}
                ${onCreateCash ? html`<button type="button" class="btn btn-ghost btn-sm btn-block" data-create-cash>${icon('banknote', 'icon-sm')}<span>افزودن یا کاهش پول نقد</span></button>` : ''}
            </div>` : ''}
        </div>
    `);

    const trigger = container.querySelector('.picker-trigger');
    const panel = container.querySelector('.picker-panel');
    const search = container.querySelector('input[type="search"]');
    const chips = container.querySelector('.chips');
    const list = container.querySelector('.picker-list');

    const heldSymbols = () => new Set(((store.portfolio && store.portfolio.holdings) || []).map((holding) => holding.symbol));

    function renderTrigger() {
        const asset = selected ? store.asset(selected) : null;
        if (!asset) {
            setHtml(trigger, html`<span class="placeholder">${selected ? selected : 'یک دارایی انتخاب کنید'}</span>${icon('chevron-down', 'chev')}`);
            return;
        }
        setHtml(trigger, html`
            ${avatar(asset, 'sm')}
            <span class="names">
                <span class="name">${asset.name}</span>
                <span class="sub">${assetSub(asset)} · ${money(asset.price)}</span>
            </span>
            ${icon('chevron-down', 'chev')}`);
    }

    function renderChips() {
        const present = new Set(store.assets.filter((asset) => !exclude.includes(asset.symbol)).map((asset) => asset.category));
        const options = [['all', 'همه']];
        if (heldSymbols().size) options.push(['held', 'دارایی‌های من']);
        for (const key of store.categories) if (present.has(key) && !exclude.includes(key)) options.push([key, CATEGORY_LABELS[key]]);
        if (!options.some(([key]) => key === 'stock')) options.push(['stock', CATEGORY_LABELS.stock]);
        setHtml(chips, options.map(([key, label]) => html`<button type="button" class="chip" data-category="${key}" aria-pressed="${category === key}">${label}</button>`));
    }

    function option(asset) {
        return html`
            <button type="button" class="picker-option ${asset.symbol === selected ? 'is-current' : ''}" role="option"
                id="${listId}-${asset.symbol}" data-symbol="${asset.symbol}" aria-selected="false" tabindex="-1">
                ${avatar(asset, 'sm')}
                <span class="names"><span class="name">${asset.name}</span><span class="sub">${assetSub(asset)}</span></span>
                <span class="price">${money(asset.price, { unit: false })}</span>
            </button>`;
    }

    function renderLocalList() {
        const tokens = searchKey(query).split(' ').filter(Boolean);
        const held = heldSymbols();
        let assets = store.assets.filter((asset) => !exclude.includes(asset.symbol) && matches(asset, tokens));
        if (category === 'held') assets = assets.filter((asset) => held.has(asset.symbol));
        else if (category !== 'all') assets = assets.filter((asset) => asset.category === category);
        if (heldFirst && held.size) {
            assets = [...assets.filter((asset) => held.has(asset.symbol)), ...assets.filter((asset) => !held.has(asset.symbol))];
        }
        assets = assets.slice(0, MAX_RESULTS);
        rendered = assets.map((asset) => asset.symbol);
        active = -1;

        if (!assets.length) {
            setHtml(list, html`<div class="picker-empty">موردی پیدا نشد${onCreateCustom ? '؛ می‌توانید آن را به‌صورت دستی تعریف کنید' : ''}.</div>`);
            return;
        }
        const grouped = !tokens.length && category === 'all';
        if (!grouped) {
            setHtml(list, assets.map(option));
            return;
        }
        const sections = [];
        const mine = assets.filter((asset) => held.has(asset.symbol));
        if (mine.length) sections.push(html`<div class="picker-group">دارایی‌های من</div>`, mine.map(option));
        for (const key of store.categories) {
            const items = assets.filter((asset) => asset.category === key && !held.has(asset.symbol));
            if (items.length) sections.push(html`<div class="picker-group">${CATEGORY_LABELS[key]}</div>`, items.map(option));
        }
        rendered = [...mine, ...store.categories.flatMap((key) => assets.filter((asset) => asset.category === key && !held.has(asset.symbol)))]
            .map((asset) => asset.symbol);
        setHtml(list, sections);
    }

    /* ---------- Tehran stocks: searched on the stock exchange, then added to the profile ---------- */

    const remote = { query: '', results: null, loading: false, error: null, token: 0, timer: null };

    function renderRemote() {
        if (category !== 'stock') return;
        const box = document.createElement('div');
        box.className = 'picker-remote';
        const text = query.trim();
        if (text.length < 2) {
            setHtml(box, html`<div class="picker-group">جستجو در بورس تهران</div><div class="picker-empty">نام یا نماد سهم را بنویسید (مثلاً فولاد یا وبملت).</div>`);
        } else if (remote.loading) {
            setHtml(box, html`<div class="picker-group">جستجو در بورس تهران</div><div class="picker-empty">${icon('refresh-cw', 'icon-sm spin')} در حال جستجو…</div>`);
        } else if (remote.error) {
            setHtml(box, html`<div class="picker-group">جستجو در بورس تهران</div><div class="picker-empty neg">${remote.error}</div>`);
        } else {
            const fresh = (remote.results || []).filter((item) => !item.tracked);
            setHtml(box, html`<div class="picker-group">از بورس تهران${fresh.length ? '' : ' (نتیجهٔ جدیدی نیست)'}</div>
                ${fresh.map((item) => html`
                    <button type="button" class="picker-option picker-remote-option" role="option" data-ins-code="${item.insCode}" tabindex="-1">
                        <span class="asset-avatar sm cat-stock">${icon('chart-column')}</span>
                        <span class="names"><span class="name">${item.ticker}</span><span class="sub">${item.name}${item.market ? ` · ${item.market}` : ''}</span></span>
                        <span class="price">افزودن</span>
                    </button>`)}`);
        }
        list.append(box);
    }

    function scheduleRemote() {
        clearTimeout(remote.timer);
        if (category !== 'stock' || query.trim().length < 2) {
            remote.results = null;
            remote.error = null;
            remote.loading = false;
            return;
        }
        remote.loading = true;
        remote.error = null;
        const token = remote.token + 1;
        remote.token = token;
        remote.timer = setTimeout(async () => {
            try {
                const results = await api.get(`/api/stocks/search?q=${encodeURIComponent(query.trim())}`);
                if (token !== remote.token) return;
                remote.results = results;
            } catch (error) {
                if (token !== remote.token) return;
                remote.results = null;
                remote.error = error.message;
            }
            remote.loading = false;
            renderList();
        }, 350);
    }

    function renderList() {
        renderLocalList();
        renderRemote();
    }

    async function trackStock(insCode) {
        try {
            const asset = await api.post('/api/stocks/track', { insCode });
            await store.loadAssets({ force: true });
            notify.success(`سهم «${asset.name}» به دارایی‌های قابل ثبت اضافه شد`);
            choose(asset.symbol);
        } catch (error) {
            notify.error(error.message);
        }
    }

    function activate(target) {
        if (!target) return;
        if (target.dataset.insCode) trackStock(target.dataset.insCode);
        else choose(target.dataset.symbol);
    }

    function setActive(index) {
        const options = [...list.querySelectorAll('.picker-option')];
        if (!options.length) return;
        active = (index + options.length) % options.length;
        options.forEach((element, i) => element.setAttribute('aria-selected', String(i === active)));
        const current = options[active];
        search.setAttribute('aria-activedescendant', current.id);
        current.scrollIntoView({ block: 'nearest' });
    }

    function onOutside(event) {
        if (!container.contains(event.target)) close();
    }

    function open() {
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        renderChips();
        renderList();
        document.addEventListener('pointerdown', onOutside, true);
        search.focus();
    }

    function close() {
        if (panel.hidden) return;
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutside, true);
    }

    function choose(symbol) {
        selected = symbol;
        close();
        renderTrigger();
        trigger.focus();
        if (onChange) onChange(symbol);
    }

    trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
    search.addEventListener('input', () => {
        query = search.value;
        scheduleRemote();
        renderList();
    });
    search.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(active + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(active - 1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            const options = list.querySelectorAll('.picker-option');
            const target = options[active >= 0 ? active : 0];
            activate(target);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            trigger.focus();
        }
    });
    chips.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-category]');
        if (!chip) return;
        category = chip.dataset.category;
        renderChips();
        scheduleRemote();
        renderList();
        search.focus();
    });
    list.addEventListener('click', (event) => {
        activate(event.target.closest('.picker-option'));
    });
    const createCash = container.querySelector('[data-create-cash]');
    if (createCash) {
        createCash.addEventListener('click', () => {
            close();
            onCreateCash();
        });
    }
    const create = container.querySelector('[data-create]');
    if (create) {
        create.addEventListener('click', async () => {
            close();
            const asset = await onCreateCustom(query.trim());
            if (asset) choose(asset.symbol);
        });
    }

    renderTrigger();

    return {
        get value() {
            return selected;
        },
        set value(symbol) {
            selected = symbol;
            renderTrigger();
        },
        open,
        close,
        refresh: renderTrigger,
        focus: () => trigger.focus(),
    };
}
