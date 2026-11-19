import { api, IS_LOCAL, setServerProfile } from './api.js';
import { setDisplayUnit } from './format.js';

const listeners = new Map();

export const store = {
    version: null,
    username: null,
    defaultPassword: false,
    preferences: null,
    providers: [],
    categories: [],
    customKinds: [],
    status: null,
    profiles: [],
    activeProfile: null,
    assets: [],
    assetMap: new Map(),
    assetsLoadedAt: 0,
    portfolio: null,

    on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return () => listeners.get(event).delete(handler);
    },

    emit(event, payload) {
        for (const handler of [...(listeners.get(event) || [])]) {
            try {
                handler(payload);
            } catch (error) {
                console.error(error);
            }
        }
    },

    async bootstrap() {
        const data = await api.get('/api/bootstrap');
        this.version = data.version;
        this.username = data.username;
        this.defaultPassword = data.defaultPassword;
        this.providers = data.providers;
        this.categories = data.categories;
        this.customKinds = data.customKinds;
        this.profiles = data.profiles || [];
        this.activeProfile = data.active || (data.profile && data.profile.id) || null;
        if (!IS_LOCAL && this.activeProfile) setServerProfile(this.activeProfile);
        this.setPreferences(data.preferences);
        this.setStatus(data.status);
    },

    activeProfileName() {
        const found = this.profiles.find((item) => item.id === this.activeProfile);
        return found ? found.name : '';
    },

    /** Drops everything loaded for the previous profile. */
    reset() {
        this.assets = [];
        this.assetMap = new Map();
        this.assetsLoadedAt = 0;
        this.portfolio = null;
        this.status = null;
    },

    /** Opens another profile: the page reloads its data through the 'profile' event. */
    async switchProfile(id) {
        if (id === this.activeProfile) return;
        if (IS_LOCAL) await api.post(`/api/profiles/${encodeURIComponent(id)}/activate`);
        else setServerProfile(id);
        this.reset();
        await this.bootstrap();
        this.activeProfile = id;
        this.emit('profile', id);
    },

    /** Re-reads the profile list (after one was added, renamed, removed or moved). */
    async refreshProfiles() {
        const data = await api.get('/api/profiles');
        this.profiles = data.profiles;
        this.emit('profiles', data.profiles);
        return data;
    },

    setPreferences(preferences) {
        const previousUnit = this.preferences && this.preferences.displayUnit;
        this.preferences = preferences;
        setDisplayUnit(preferences.displayUnit);
        this.emit('preferences', preferences);
        if (previousUnit && previousUnit !== preferences.displayUnit) this.emit('unit', preferences.displayUnit);
    },

    setStatus(status) {
        const previous = this.status;
        this.status = status;
        this.emit('status', status);
        const stocksChanged = previous && previous.stocks && status.stocks && previous.stocks.lastSuccessAt !== status.stocks.lastSuccessAt;
        if (previous && ((status.lastSuccessAt && previous.lastSuccessAt !== status.lastSuccessAt) || stocksChanged)) {
            this.assetsLoadedAt = 0;
            this.emit('synced', status);
        }
    },

    async refreshStatus() {
        this.setStatus(await api.get('/api/status'));
        return this.status;
    },

    async loadAssets({ force = false } = {}) {
        if (!force && this.assets.length && Date.now() - this.assetsLoadedAt < 60 * 1000) return this.assets;
        const list = await api.get('/api/assets');
        this.assets = list;
        this.assetMap = new Map(list.map((asset) => [asset.symbol, asset]));
        this.assetsLoadedAt = Date.now();
        this.emit('assets', list);
        return list;
    },

    asset(symbol) {
        return this.assetMap.get(symbol) || null;
    },

    async loadPortfolio() {
        this.portfolio = await api.get('/api/portfolio');
        return this.portfolio;
    },

    holding(symbol) {
        const holdings = this.portfolio ? this.portfolio.holdings : [];
        return holdings.find((holding) => holding.symbol === symbol) || null;
    },

    async savePreferences(patch) {
        const result = await api.put('/api/settings', patch);
        this.setPreferences(result.preferences);
        this.setStatus(result.status);
        return result;
    },

    isWatched(symbol) {
        return Boolean(this.preferences && this.preferences.watchlist.includes(symbol));
    },

    async toggleWatch(symbol) {
        const list = [...this.preferences.watchlist];
        const index = list.indexOf(symbol);
        if (index === -1) list.push(symbol);
        else list.splice(index, 1);
        await this.savePreferences({ watchlist: list });
        return index === -1;
    },

    /** Call after transactions or custom assets change. */
    dataChanged() {
        this.assetsLoadedAt = 0;
        this.emit('data-changed');
    },
};
