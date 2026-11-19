// App lock of the in-app editions (DollarBaan Plus). The password never leaves the device: only a salted
// PBKDF2 hash is kept, in localStorage, next to an optional hint shown on the lock screen.
// While locked, the page cannot reach any data (api.js waits for the lock to open).
//
// This keeps people out of the app. It does not encrypt the files on disk: use device encryption for that.

const KEY = 'dollarbaanplus.lock';
const ITERATIONS = 200000;
const MIN_LENGTH = 4;
const MAX_LENGTH = 128;
export const AUTO_LOCK_CHOICES = [[0, 'هرگز'], [1, 'یک دقیقه'], [5, 'پنج دقیقه'], [15, 'پانزده دقیقه'], [30, 'سی دقیقه'], [60, 'یک ساعت']];

const listeners = new Set();
let unlocked = true;
let gate = Promise.resolve();
let release = null;
let failures = 0;
let blockedUntil = 0;

function read() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY));
        return saved && saved.salt && saved.hash ? saved : null;
    } catch {
        return null;
    }
}

function write(config) {
    try {
        if (config) localStorage.setItem(KEY, JSON.stringify(config));
        else localStorage.removeItem(KEY);
    } catch {
        throw new Error('ذخیره‌سازی مرورگر در دسترس نیست و قفل ذخیره نشد');
    }
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function derive(password, salt, iterations) {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, 256);
    return toBase64(bits);
}

function emit() {
    for (const handler of [...listeners]) {
        try {
            handler({ enabled: isEnabled(), locked: !unlocked });
        } catch {
            /* a failing listener must not break the lock */
        }
    }
}

export const onLockChange = (handler) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
};

export const canUseLock = () => Boolean(globalThis.crypto && crypto.subtle && crypto.getRandomValues);
export const isEnabled = () => Boolean(read());
export const isLocked = () => !unlocked;
export const hint = () => (read() || {}).hint || '';
export const autoLockMinutes = () => Number((read() || {}).autoLockMinutes) || 0;
export const waitUntilUnlocked = () => gate;

export function lock() {
    if (!isEnabled() || !unlocked) return;
    unlocked = false;
    gate = new Promise((resolve) => {
        release = resolve;
    });
    emit();
}

function open() {
    unlocked = true;
    failures = 0;
    blockedUntil = 0;
    if (release) release();
    release = null;
    gate = Promise.resolve();
    emit();
}

/** Tries a password. Resolves { ok } or { ok: false, retryAfter } (seconds) after repeated mistakes. */
export async function unlock(password) {
    const config = read();
    if (!config) {
        open();
        return { ok: true };
    }
    const wait = Math.ceil((blockedUntil - Date.now()) / 1000);
    if (wait > 0) return { ok: false, retryAfter: wait };
    const hash = await derive(String(password), fromBase64(config.salt), config.iterations || ITERATIONS);
    if (hash === config.hash) {
        open();
        return { ok: true };
    }
    failures += 1;
    if (failures >= 3) blockedUntil = Date.now() + Math.min(60, 2 ** (failures - 2)) * 1000;
    return { ok: false, retryAfter: Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000)) };
}

function checkPassword(password) {
    const text = String(password || '');
    if (text.length < MIN_LENGTH) throw new Error(`رمز باید حداقل ${MIN_LENGTH} نویسه باشد`);
    if (text.length > MAX_LENGTH) throw new Error('رمز بیش از حد طولانی است');
    return text;
}

function cleanHint(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function build(password, hintText, minutes) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return {
        v: 1,
        iterations: ITERATIONS,
        salt: toBase64(salt),
        hash: await derive(password, salt, ITERATIONS),
        hint: cleanHint(hintText),
        autoLockMinutes: Number(minutes) || 0,
    };
}

async function verifyCurrent(password) {
    const config = read();
    if (!config) return false;
    return (await derive(String(password), fromBase64(config.salt), config.iterations || ITERATIONS)) === config.hash;
}

export async function enable({ password, hint: hintText, autoLockMinutes: minutes = 5 }) {
    if (!canUseLock()) throw new Error('این محیط از رمزنگاری لازم برای قفل پشتیبانی نمی‌کند');
    write(await build(checkPassword(password), hintText, minutes));
    emit();
}

export async function changePassword({ current, password, hint: hintText }) {
    if (!(await verifyCurrent(current))) throw new Error('رمز فعلی درست نیست');
    write(await build(checkPassword(password), hintText, autoLockMinutes()));
    emit();
}

export async function updateHint({ current, hint: hintText }) {
    if (!(await verifyCurrent(current))) throw new Error('رمز فعلی درست نیست');
    write({ ...read(), hint: cleanHint(hintText) });
    emit();
}

export async function disable(password) {
    if (!(await verifyCurrent(password))) throw new Error('رمز فعلی درست نیست');
    write(null);
    open();
}

export function setAutoLock(minutes) {
    const config = read();
    if (!config) return;
    write({ ...config, autoLockMinutes: Number(minutes) || 0 });
    emit();
}

/** Deletes every database and setting of the app on this device (the only way back in after a forgotten password). */
export async function wipeEverything() {
    const names = new Set();
    try {
        const saved = JSON.parse(localStorage.getItem('dollarbaanplus.profiles'));
        for (const profile of (saved && saved.profiles) || []) names.add(`dollarbaanplus-${profile.id}`);
    } catch {
        /* nothing registered */
    }
    try {
        if (indexedDB.databases) for (const db of await indexedDB.databases()) if (db.name) names.add(db.name);
    } catch {
        /* older WebViews cannot list databases */
    }
    await Promise.all([...names].map((name) => new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
    })));
    try {
        for (const key of Object.keys(localStorage)) if (key.startsWith('dollarbaan')) localStorage.removeItem(key);
    } catch {
        /* storage unavailable */
    }
}

// The app starts locked when a lock is set.
lock();

// Lock again after the app was out of sight for the chosen time.
let hiddenAt = 0;
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            hiddenAt = Date.now();
            return;
        }
        const minutes = autoLockMinutes();
        if (hiddenAt && minutes > 0 && Date.now() - hiddenAt >= minutes * 60 * 1000) lock();
        hiddenAt = 0;
    });
}
