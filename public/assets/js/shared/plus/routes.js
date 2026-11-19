// DollarBaan Plus API, added to the upstream routes by the Node server and the in-app backend.
// Same shape as upstream: { method, path, handler(ctx), status?, download? } with
// ctx = { params, query, body, session, profile }. Routes listed first win, so the exports
// here replace upstream's (same paths, richer content).
import { tehranDate } from '../dates.js';
import { badRequest } from '../errors.js';

function fileSafe(name) {
    return String(name || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * @param {object} deps
 * @param {object} deps.plus       the object returned by createPlus()
 * @param {object} deps.portfolio  PlusPortfolioCore
 */
export function createPlusRoutes({ plus, portfolio }) {
    const { cash, locations, withdrawals, stocks, pnl } = plus;
    return [
        /* ---------- backup (replaces upstream's exports) ---------- */
        {
            method: 'GET',
            path: '/export',
            download: true,
            handler: async ({ profile }) => {
                const name = profile && profile.name ? profile.name : null;
                const tag = fileSafe(name);
                return {
                    filename: `dollarbaanplus-backup${tag ? `-${tag}` : ''}-${tehranDate()}.json`,
                    type: 'application/json; charset=utf-8',
                    body: JSON.stringify(await portfolio.exportData({ name }), null, 2),
                };
            },
        },
        {
            method: 'GET',
            path: '/export.csv',
            download: true,
            handler: async ({ profile }) => {
                const tag = fileSafe(profile && profile.name);
                return {
                    filename: `dollarbaanplus-transactions${tag ? `-${tag}` : ''}-${tehranDate()}.csv`,
                    type: 'text/csv; charset=utf-8',
                    body: await portfolio.exportCsv(),
                };
            },
        },

        /* ---------- holdings: lots and locations ---------- */
        {
            method: 'GET',
            path: '/portfolio/lots',
            handler: ({ query }) => portfolio.getLots(String(query.symbol || '')),
        },
        { method: 'GET', path: '/locations', handler: () => locations.list() },
        { method: 'POST', path: '/locations', status: 201, handler: ({ body }) => locations.add(body && body.name) },
        { method: 'PUT', path: '/locations', handler: ({ body }) => locations.rename(body && body.from, body && body.to) },
        { method: 'DELETE', path: '/locations', handler: ({ query }) => locations.removeSaved(query.name) },

        /* ---------- cash ---------- */
        {
            method: 'GET',
            path: '/cash/overview',
            handler: ({ query }) => cash.overview({
                from: query.from || null,
                to: query.to || null,
                sourceId: query.source || null,
                location: query.location === undefined ? null : query.location,
                direction: query.direction || null,
            }),
        },
        { method: 'GET', path: '/cash/sources', handler: () => cash.sources({ includeArchived: true }) },
        { method: 'POST', path: '/cash/sources', status: 201, handler: ({ body }) => cash.createSource(body || {}) },
        { method: 'PUT', path: '/cash/sources/:id', handler: ({ params, body }) => cash.updateSource(params.id, body || {}) },
        { method: 'DELETE', path: '/cash/sources/:id', status: 204, handler: ({ params }) => cash.deleteSource(params.id) },

        /* ---------- Tehran stocks ---------- */
        { method: 'GET', path: '/stocks/search', handler: ({ query }) => stocks.search(query.q) },
        { method: 'POST', path: '/stocks/track', status: 201, handler: ({ body }) => stocks.track(body && body.insCode) },
        { method: 'DELETE', path: '/stocks/:symbol', status: 204, handler: ({ params }) => stocks.untrack(params.symbol) },
        {
            method: 'POST',
            path: '/stocks/sync',
            handler: async () => {
                await stocks.sync({ reason: 'manual' });
                return stocks.publicStatus();
            },
        },

        /* ---------- profit withdrawals ---------- */
        { method: 'GET', path: '/withdrawals', handler: () => withdrawals.list() },
        { method: 'GET', path: '/withdrawals/preview', handler: ({ query }) => withdrawals.preview({ date: query.date }) },
        { method: 'POST', path: '/withdrawals', status: 201, handler: ({ body }) => withdrawals.create(body || {}) },
        { method: 'PUT', path: '/withdrawals/:id', handler: ({ params, body }) => withdrawals.updateNote(params.id, body && body.note) },
        { method: 'DELETE', path: '/withdrawals/:id', status: 204, handler: ({ params }) => withdrawals.remove(params.id) },

        /* ---------- profit and loss ---------- */
        {
            method: 'GET',
            path: '/pnl',
            handler: ({ query }) => {
                if (query.mode && query.mode !== 'all' && query.mode !== 'period') throw badRequest('حالت گزارش معتبر نیست');
                return pnl.compute(query);
            },
        },
    ];
}
