// A compact multi-select (dropdown with search and checkboxes) for filters.
import { html, icon, setHtml } from '../lib/dom.js';
import { searchKey } from '../format.js';

let uid = 0;

/**
 * @param {HTMLElement} container
 * @param {{ options: {value: string, label: string, sub?: string}[], selected?: string[], allLabel: string,
 *           countLabel: (n: number) => string, searchable?: boolean, onChange: (values: string[]) => void }} config
 */
export function createMultiSelect(container, { options, selected = [], allLabel, countLabel, searchable = true, onChange }) {
    uid += 1;
    const panelId = `ms-panel-${uid}`;
    const chosen = new Set(selected);
    let query = '';

    setHtml(container, html`
        <div class="multi-select">
            <button type="button" class="select multi-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${panelId}"></button>
            <div class="multi-panel" id="${panelId}" hidden>
                ${searchable ? html`<label class="search-input">${icon('search')}<input class="input" type="search" placeholder="جستجو…" aria-label="جستجو" autocomplete="off"></label>` : ''}
                <div class="multi-list" role="listbox" aria-multiselectable="true"></div>
                <div class="multi-foot"><button type="button" class="btn btn-ghost btn-sm" data-clear>پاک کردن انتخاب</button>
                    <button type="button" class="btn btn-primary btn-sm" data-done>تأیید</button></div>
            </div>
        </div>`);
    const trigger = container.querySelector('.multi-trigger');
    const panel = container.querySelector('.multi-panel');
    const list = container.querySelector('.multi-list');
    const search = container.querySelector('input[type="search"]');

    function renderTrigger() {
        trigger.textContent = chosen.size ? countLabel(chosen.size) : allLabel;
        trigger.classList.toggle('has-value', chosen.size > 0);
    }

    function renderList() {
        const tokens = searchKey(query).split(' ').filter(Boolean);
        const visible = options.filter((option) => !tokens.length || tokens.every((token) => searchKey(`${option.label} ${option.sub || ''}`).includes(token)));
        setHtml(list, visible.length ? visible.map((option) => html`
            <label class="multi-option" role="option" aria-selected="${chosen.has(option.value)}">
                <input type="checkbox" value="${option.value}" ${chosen.has(option.value) ? html`checked` : ''}>
                <span class="grow"><span class="name">${option.label}</span>${option.sub ? html`<span class="sub">${option.sub}</span>` : ''}</span>
            </label>`) : html`<div class="picker-empty">موردی پیدا نشد.</div>`);
    }

    function onOutside(event) {
        if (!container.contains(event.target)) close();
    }

    function open() {
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        renderList();
        document.addEventListener('pointerdown', onOutside, true);
        if (search) search.focus();
    }

    function close({ emit = true } = {}) {
        if (panel.hidden) return;
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutside, true);
        if (emit) onChange([...chosen]);
    }

    trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
    list.addEventListener('change', (event) => {
        const box = event.target.closest('input[type="checkbox"]');
        if (!box) return;
        if (box.checked) chosen.add(box.value);
        else chosen.delete(box.value);
        box.closest('.multi-option').setAttribute('aria-selected', String(box.checked));
        renderTrigger();
    });
    if (search) {
        search.addEventListener('input', () => {
            query = search.value;
            renderList();
        });
    }
    container.querySelector('[data-clear]').addEventListener('click', () => {
        chosen.clear();
        renderTrigger();
        renderList();
    });
    container.querySelector('[data-done]').addEventListener('click', () => close());
    container.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !panel.hidden) {
            event.stopPropagation();
            close();
            trigger.focus();
        }
    });

    renderTrigger();
    return {
        get values() {
            return [...chosen];
        },
        destroy() {
            document.removeEventListener('pointerdown', onOutside, true);
        },
    };
}
