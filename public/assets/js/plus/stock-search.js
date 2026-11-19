// Search for Tehran stocks and funds on the stock exchange and add them to the open profile.
import { html, icon, setHtml, debounce } from '../lib/dom.js';
import { api } from '../api.js';
import { store } from '../state.js';
import { notify } from '../ui/toast.js';

/**
 * @param {HTMLElement} host
 * @param {{ onTracked?: (asset: object) => void }} options
 * @returns {() => void} removes the panel's listeners
 */
export function mountStockSearch(host, { onTracked } = {}) {
    let token = 0;
    const state = { query: '', results: null, loading: false, error: null };

    function renderResults() {
        const target = host.querySelector('[data-stock-results]');
        if (!target) return;
        if (state.query.trim().length < 2) {
            setHtml(target, html`<p class="field-hint">نام یا نماد سهم را بنویسید؛ مثلاً «فولاد»، «خودرو» یا «وبملت». صندوق‌های سرمایه‌گذاری هم پیدا می‌شوند.</p>`);
        } else if (state.loading) {
            setHtml(target, html`<p class="field-hint">${icon('refresh-cw', 'icon-sm spin')} در حال جستجو در بورس…</p>`);
        } else if (state.error) {
            setHtml(target, html`<div class="alert error" style="margin:0">${icon('circle-alert')}<div class="grow">${state.error}</div></div>`);
        } else if (!state.results.length) {
            setHtml(target, html`<p class="field-hint">نمادی پیدا نشد.</p>`);
        } else {
            setHtml(target, html`<div class="list">${state.results.map((item) => html`
                <div class="list-row">
                    <span class="asset-avatar sm cat-stock">${icon('chart-column')}</span>
                    <div class="grow">
                        <span class="title">${item.ticker}</span>
                        <span class="meta">${item.name}${item.market ? ` · ${item.market}` : ''}</span>
                    </div>
                    ${item.tracked
                        ? html`<a class="btn btn-ghost btn-sm" href="#/asset/${item.symbol}">${icon('check', 'icon-sm')}<span>اضافه شده</span></a>`
                        : html`<button type="button" class="btn btn-secondary btn-sm" data-track="${item.insCode}">${icon('plus', 'icon-sm')}<span>افزودن</span></button>`}
                </div>`)}</div>`);
        }
    }

    const search = debounce(async () => {
        const current = ++token;
        const text = state.query.trim();
        if (text.length < 2) {
            state.loading = false;
            renderResults();
            return;
        }
        try {
            const results = await api.get(`/api/stocks/search?q=${encodeURIComponent(text)}`);
            if (current !== token) return;
            Object.assign(state, { results, error: null, loading: false });
        } catch (error) {
            if (current !== token) return;
            Object.assign(state, { results: null, error: error.message, loading: false });
        }
        renderResults();
    }, 350);

    setHtml(host, html`
        <div class="card card-pad stock-panel">
            <div class="card-head" style="padding:0 0 10px"><h2>سهام بورس تهران</h2><span class="sub">قیمت‌ها به تومان</span></div>
            <label class="search-input">${icon('search')}
                <input class="input" type="search" placeholder="جستجوی نام یا نماد سهم…" aria-label="جستجوی سهام" autocomplete="off" data-stock-query>
            </label>
            <div data-stock-results style="margin-top:10px"></div>
        </div>`);
    renderResults();

    const onInput = (event) => {
        if (!event.target.matches('[data-stock-query]')) return;
        state.query = event.target.value;
        state.loading = state.query.trim().length >= 2;
        renderResults();
        search();
    };
    const onClick = async (event) => {
        const button = event.target.closest('[data-track]');
        if (!button) return;
        button.disabled = true;
        try {
            const asset = await api.post('/api/stocks/track', { insCode: button.dataset.track });
            await store.loadAssets({ force: true });
            notify.success(`سهم «${asset.name}» اضافه شد؛ حالا می‌توانید خرید و فروش آن را ثبت کنید`);
            if (state.results) for (const item of state.results) if (item.insCode === button.dataset.track) item.tracked = true;
            renderResults();
            if (onTracked) onTracked(asset);
        } catch (error) {
            notify.error(error.message);
            button.disabled = false;
        }
    };
    host.addEventListener('input', onInput);
    host.addEventListener('click', onClick);
    return () => {
        host.removeEventListener('input', onInput);
        host.removeEventListener('click', onClick);
    };
}
