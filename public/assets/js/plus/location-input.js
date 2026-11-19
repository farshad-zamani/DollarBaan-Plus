// "Storage location" field: free text with suggestions from what the profile already uses.
import { html, setHtml } from '../lib/dom.js';
import { api } from '../api.js';

let uid = 0;
let cache = null;

/** Names already used or saved in the open profile (cached until a transaction changes them). */
export async function loadLocations({ force = false } = {}) {
    if (cache && !force) return cache;
    try {
        cache = (await api.get('/api/locations')).map((item) => item.name);
    } catch {
        cache = [];
    }
    return cache;
}

export const forgetLocations = () => {
    cache = null;
};

/**
 * @param {HTMLElement} container
 * @param {{ value?: string, placeholder?: string, id?: string }} options
 * @returns {{ value: string, input: HTMLInputElement }}
 */
export function createLocationInput(container, { value = '', placeholder = 'مثلاً صرافی، بانک ملت یا گاوصندوق', id = null } = {}) {
    uid += 1;
    const listId = `locations-${uid}`;
    const inputId = id || `location-${uid}`;
    setHtml(container, html`
        <input id="${inputId}" class="input" maxlength="80" list="${listId}" autocomplete="off" placeholder="${placeholder}" value="${value}">
        <datalist id="${listId}"></datalist>`);
    const input = container.querySelector('input');
    const list = container.querySelector('datalist');
    loadLocations().then((names) => {
        setHtml(list, names.map((name) => html`<option value="${name}"></option>`));
    });
    return {
        input,
        get value() {
            return input.value.replace(/\s+/g, ' ').trim();
        },
        set value(next) {
            input.value = next || '';
        },
    };
}
