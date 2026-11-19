// Storage locations ("محل نگهداری") for DollarBaan Plus: where an asset or cash is kept
// (an exchange, a bank, a safe, a wallet...). A location is free text on a transaction; this
// core only adds suggestions, a saved list and bulk rename.
import { badRequest } from '../errors.js';

export const MAX_LOCATION = 80;
export const NO_LOCATION_LABEL = 'بدون محل نگهداری';

export function cleanLocation(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_LOCATION);
}

export class LocationsCore {
    /**
     * @param {object} options
     * @param {object} options.store      storage adapter
     * @param {object} options.settings   SettingsCore
     * @param {object} options.portfolio  PlusPortfolioCore
     */
    constructor({ store, settings, portfolio }) {
        this.store = store;
        this.settings = settings;
        this.portfolio = portfolio;
    }

    saved() {
        const list = this.settings.get('locations');
        return Array.isArray(list) ? list.map(cleanLocation).filter(Boolean) : [];
    }

    /** Saved names plus every name already used on a transaction, with usage counts. */
    async list() {
        const counts = new Map();
        for (const tx of await this.portfolio.allTransactions()) {
            if (tx.location) counts.set(tx.location, (counts.get(tx.location) || 0) + 1);
        }
        const names = new Set([...this.saved(), ...counts.keys()]);
        return [...names]
            .map((name) => ({ name, count: counts.get(name) || 0, saved: this.saved().includes(name) }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fa'));
    }

    async add(name) {
        const clean = cleanLocation(name);
        if (!clean) throw badRequest('نام محل نگهداری را وارد کنید');
        const saved = this.saved();
        if (saved.length >= 200) throw badRequest('تعداد محل‌های ذخیره‌شده به سقف مجاز رسیده است');
        if (!saved.includes(clean)) await this.settings.set('locations', [...saved, clean]);
        return this.list();
    }

    /** Renames a location everywhere: the saved list and every transaction that uses it. */
    async rename(from, to) {
        const oldName = cleanLocation(from);
        const newName = cleanLocation(to);
        if (!oldName || !newName) throw badRequest('نام محل نگهداری را وارد کنید');
        const rows = (await this.portfolio.allTransactions()).filter((tx) => tx.location === oldName);
        if (rows.length) {
            const now = new Date();
            await this.store.writeBatch({ update: rows.map((tx) => ({ id: tx.id, patch: { location: newName, updatedAt: now } })) });
        }
        const saved = this.saved().map((name) => (name === oldName ? newName : name));
        await this.settings.set('locations', [...new Set(saved)]);
        return this.list();
    }

    /** Removes a name from the saved list; transactions keep it (it still shows as a suggestion). */
    async removeSaved(name) {
        const clean = cleanLocation(name);
        await this.settings.set('locations', this.saved().filter((item) => item !== clean));
        return this.list();
    }
}
