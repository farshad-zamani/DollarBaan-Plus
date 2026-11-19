// IndexedDB storage adapter for the in-app backend (desktop, mobile and static web builds).
// Implements the same interface as server/store.js.

export const DB_NAME = 'dollarbaan';
// Version 2 (DollarBaan Plus) adds the generic `docs` store (cash sources, profit withdrawals, ...).
const DB_VERSION = 2;
const HIGH = '\uffff';

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function open(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
            if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'symbol' });
            if (!db.objectStoreNames.contains('transactions')) {
                db.createObjectStore('transactions', { keyPath: 'id' }).createIndex('symbol', 'symbol');
            }
            if (!db.objectStoreNames.contains('prices')) db.createObjectStore('prices', { keyPath: ['symbol', 'date'] });
            if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' }).createIndex('type', 'type');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('پایگاه داده محلی در پنجره دیگری باز است؛ آن پنجره را ببندید'));
    });
}

const priceRange = (symbol) => IDBKeyRange.bound([symbol, ''], [symbol, HIGH]);

/** Opens the database and returns the storage adapter. Each profile uses its own database name. */
export async function openStore(name = DB_NAME) {
    const db = await open(name);

    /**
     * Runs `work(stores)` in one transaction. `work` may only await requests of this
     * transaction (anything else would let IndexedDB auto-commit it).
     */
    function run(names, mode, work) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(names, mode);
            const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
            let result;
            Promise.resolve()
                .then(() => work(stores))
                .then((value) => {
                    result = value;
                }, (error) => {
                    try {
                        transaction.abort();
                    } catch {
                        /* already finished */
                    }
                    reject(error);
                });
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('عملیات پایگاه داده لغو شد'));
        });
    }

    const read = (name, work) => run([name], 'readonly', (stores) => work(stores[name]));
    const write = (name, work) => run([name], 'readwrite', (stores) => work(stores[name]));

    return {
        async listSettings() {
            return read('settings', (store) => promisify(store.getAll()));
        },

        async putSetting(key, value) {
            await write('settings', (store) => promisify(store.put({ key, value })));
        },

        async listAssets() {
            return read('assets', (store) => promisify(store.getAll()));
        },

        async upsertAssets(rows) {
            await write('assets', async (store) => {
                for (const row of rows) store.put(row);
            });
        },

        async setListed(symbols, listed) {
            await write('assets', async (store) => {
                for (const symbol of symbols) {
                    const row = await promisify(store.get(symbol));
                    if (row) store.put({ ...row, listed });
                }
            });
        },

        async insertAsset(row) {
            await write('assets', (store) => promisify(store.add(row)));
        },

        async updateAsset(symbol, patch) {
            await write('assets', async (store) => {
                const row = await promisify(store.get(symbol));
                if (row) store.put({ ...row, ...patch });
            });
        },

        async deleteAsset(symbol) {
            await write('assets', (store) => promisify(store.delete(symbol)));
        },

        async heldSymbols() {
            const rows = await read('transactions', (store) => promisify(store.getAll()));
            return [...new Set(rows.map((row) => row.symbol))];
        },

        async firstTransactionDate() {
            const rows = await read('transactions', (store) => promisify(store.getAll()));
            return rows.reduce((min, row) => (!min || row.date < min ? row.date : min), null);
        },

        async countTransactions(symbol) {
            return read('transactions', (store) => promisify(store.index('symbol').count(symbol)));
        },

        async allTransactions() {
            return read('transactions', (store) => promisify(store.getAll()));
        },

        async transactionsFor(symbols) {
            return read('transactions', async (store) => {
                const index = store.index('symbol');
                const lists = [];
                for (const symbol of new Set(symbols)) lists.push(await promisify(index.getAll(symbol)));
                return lists.flat();
            });
        },

        async getTransaction(id) {
            return (await read('transactions', (store) => promisify(store.get(id)))) || null;
        },

        async insertTransaction(row) {
            await write('transactions', (store) => promisify(store.add(row)));
        },

        async updateTransaction(id, patch) {
            await write('transactions', async (store) => {
                const row = await promisify(store.get(id));
                if (row) store.put({ ...row, ...patch });
            });
        },

        async deleteTransaction(id) {
            await write('transactions', (store) => promisify(store.delete(id)));
        },

        async listPrices(symbol) {
            const rows = await read('prices', (store) => promisify(store.getAll(priceRange(symbol))));
            return rows.map((row) => ({ date: row.date, close: row.close }));
        },

        async getPrice(symbol, date) {
            return (await read('prices', (store) => promisify(store.get([symbol, date])))) || null;
        },

        async putPrice(row) {
            await write('prices', (store) => promisify(store.put(row)));
        },

        async upsertPrices(rows) {
            if (!rows.length) return;
            await write('prices', async (store) => {
                for (const row of rows) store.put(row);
            });
        },

        async providerPriceRange(symbol) {
            const rows = await read('prices', (store) => promisify(store.getAll(priceRange(symbol))));
            const dates = rows.filter((row) => row.origin === 'provider').map((row) => row.date);
            return dates.length ? { first: dates[0], last: dates[dates.length - 1] } : { first: null, last: null };
        },

        async deletePrices(symbol) {
            await write('prices', (store) => promisify(store.delete(priceRange(symbol))));
        },

        /** Writes a restored backup atomically. `docs` (Plus) are replaced as a whole when `replace` is set. */
        async importBackup({ assets, prices, transactions, replace, docs = null }) {
            await run(['assets', 'prices', 'transactions', 'docs'], 'readwrite', async (stores) => {
                for (const asset of assets) stores.assets.put(asset);
                for (const price of prices) stores.prices.put(price);
                if (replace) await promisify(stores.transactions.clear());
                for (const transaction of transactions) stores.transactions.put(transaction);
                if (docs) {
                    if (replace) await promisify(stores.docs.clear());
                    for (const doc of docs) stores.docs.put(doc);
                }
            });
        },

        /* ---------- Plus: generic documents and atomic batches ---------- */

        /** Documents of one type ({ id, type, ...fields }). */
        async listDocs(type) {
            return read('docs', (store) => promisify(store.index('type').getAll(type)));
        },

        async putDoc(doc) {
            await write('docs', (store) => promisify(store.put(doc)));
        },

        async deleteDoc(id) {
            await write('docs', (store) => promisify(store.delete(id)));
        },

        /**
         * Applies several transaction and document changes atomically:
         * { insert: [rows], update: [{ id, patch }], remove: [ids], putDocs: [docs], removeDocs: [ids] }
         */
        async writeBatch({ insert = [], update = [], remove = [], putDocs = [], removeDocs = [] }) {
            await run(['transactions', 'docs'], 'readwrite', async (stores) => {
                for (const row of insert) await promisify(stores.transactions.add(row));
                for (const { id, patch } of update) {
                    const row = await promisify(stores.transactions.get(id));
                    if (row) stores.transactions.put({ ...row, ...patch });
                }
                for (const id of remove) stores.transactions.delete(id);
                for (const doc of putDocs) stores.docs.put(doc);
                for (const id of removeDocs) stores.docs.delete(id);
            });
        },

        /** Deletes every record on this device. */
        async clearAll() {
            await run(['settings', 'assets', 'prices', 'transactions', 'docs'], 'readwrite', async (stores) => {
                for (const store of Object.values(stores)) store.clear();
            });
        },

        /** Closes the connection (used when a profile is deleted). */
        close() {
            db.close();
        },
    };
}
