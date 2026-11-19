// Profile registry of the in-app backend (DollarBaan Plus). Every profile is a completely separate
// database ("tab" in the app): its own transactions, cash, stocks, settings and watchlist.
// Only this small list (names and which one is open) is kept outside the profile databases.

const KEY = 'dollarbaanplus.profiles';
const DEFAULT_NAME = 'پروفایل من';
const MAX_PROFILES = 50;
const MAX_NAME = 40;

export function cleanProfileName(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return `p${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** IndexedDB name of a profile. */
export const databaseName = (id) => `dollarbaanplus-${id}`;

function load() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY));
        if (saved && Array.isArray(saved.profiles) && saved.profiles.length) {
            const profiles = saved.profiles.filter((item) => item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(item.id));
            if (profiles.length) {
                const active = profiles.some((item) => item.id === saved.active) ? saved.active : profiles[0].id;
                return { profiles, active };
            }
        }
    } catch {
        /* first launch, or storage unavailable */
    }
    const first = { id: 'main', name: DEFAULT_NAME, createdAt: new Date().toISOString() };
    return { profiles: [first], active: first.id };
}

let state = load();

function save() {
    try {
        localStorage.setItem(KEY, JSON.stringify({ v: 1, ...state }));
    } catch {
        /* kept in memory for this session */
    }
}
save();

export const list = () => state.profiles.map((item) => ({ ...item, active: item.id === state.active }));
export const activeId = () => state.active;
export const find = (id) => state.profiles.find((item) => item.id === id) || null;

function uniqueName(name, exceptId = null) {
    const clean = cleanProfileName(name);
    if (!clean) return { error: 'نام پروفایل را وارد کنید' };
    const clash = state.profiles.some((item) => item.id !== exceptId && item.name.toLowerCase() === clean.toLowerCase());
    return clash ? { error: 'پروفایلی با این نام وجود دارد' } : { name: clean };
}

/** Adds a profile (an explicit id is used when restoring a full backup). Returns { profile } or { error }. */
export function add(name, { id = null } = {}) {
    if (state.profiles.length >= MAX_PROFILES) return { error: 'تعداد پروفایل‌ها به سقف مجاز رسیده است' };
    const checked = uniqueName(name);
    if (checked.error) return checked;
    let newId = id && /^[A-Za-z0-9_-]{1,32}$/.test(id) && !find(id) ? id : randomId();
    while (find(newId)) newId = randomId();
    const profile = { id: newId, name: checked.name, createdAt: new Date().toISOString() };
    state.profiles.push(profile);
    save();
    return { profile };
}

export function rename(id, name) {
    const profile = find(id);
    if (!profile) return { error: 'پروفایل پیدا نشد' };
    const checked = uniqueName(name, id);
    if (checked.error) return checked;
    profile.name = checked.name;
    save();
    return { profile };
}

export function remove(id) {
    if (state.profiles.length <= 1) return { error: 'حداقل یک پروفایل باید باقی بماند' };
    if (!find(id)) return { error: 'پروفایل پیدا نشد' };
    state.profiles = state.profiles.filter((item) => item.id !== id);
    if (state.active === id) state.active = state.profiles[0].id;
    save();
    return { ok: true };
}

export function activate(id) {
    if (!find(id)) return false;
    state.active = id;
    save();
    return true;
}

/** Order of the tabs: ids in their new order. Unknown ids are ignored; missing ones keep their place at the end. */
export function reorder(ids) {
    const order = new Map(ids.map((id, index) => [id, index]));
    state.profiles.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e6) - (order.has(b.id) ? order.get(b.id) : 1e6));
    save();
}
