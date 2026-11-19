'use strict';

const express = require('express');
const auth = require('../services/auth');
const runtimes = require('../services/runtimes');
const { tehranDate } = require('../shared').dates;
const { badRequest } = require('../lib/errors');
const { contentDisposition } = require('../lib/http');

const router = express.Router();

// Data endpoints are shared with the in-app backend of the desktop and mobile apps.
// DollarBaan Plus: every profile has its own set of them (see services/runtimes.js).

/* ---------- server-only: account ---------- */

router.post('/account/password', async (req, res) => {
    const { current, next } = req.body || {};
    await auth.changePassword(current, next);
    await auth.destroyOtherSessions(req.session.id);
    res.json({ ok: true });
});

router.post('/account/logout-others', async (req, res) => {
    const removed = await auth.destroyOtherSessions(req.session.id);
    res.json({ ok: true, removed });
});

/* ---------- profiles and full backups ---------- */

/** The profile a request is about: ?profile=, the X-Profile header, or the main one. */
function requestedProfile(req) {
    return String(req.query.profile || req.get('x-profile') || runtimes.MAIN);
}

function describe(req) {
    const active = runtimes.entryOf(requestedProfile(req)) ? requestedProfile(req) : runtimes.MAIN;
    return { profiles: runtimes.list(), active };
}

router.get('/profiles', (req, res) => res.json(describe(req)));

router.post('/profiles', async (req, res) => {
    const { name, payload } = req.body || {};
    const entry = await runtimes.create(name);
    if (payload) {
        try {
            await (await runtimes.get(entry.id)).portfolio.importData(payload, { mode: 'replace' });
        } catch (error) {
            await runtimes.remove(entry.id).catch(() => {});
            throw error;
        }
    }
    res.status(201).json({ ...describe(req), created: entry.id });
});

router.put('/profiles-order', async (req, res) => {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    await runtimes.reorder(ids);
    res.json(describe(req));
});

router.put('/profiles/:id', async (req, res) => {
    await runtimes.rename(req.params.id, req.body && req.body.name);
    res.json(describe(req));
});

router.delete('/profiles/:id', async (req, res) => {
    await runtimes.remove(req.params.id);
    res.json(describe(req));
});

router.get('/backup/full', async (req, res) => {
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', contentDisposition(`dollarbaanplus-full-backup-${tehranDate()}.json`));
    res.send(JSON.stringify(await runtimes.exportFull(), null, 2));
});

router.post('/backup/full', async (req, res) => {
    if (!req.body || typeof req.body !== 'object') throw badRequest('فایل پشتیبان معتبر نیست');
    res.json(await runtimes.importFull(req.body, req.query.mode === 'replace' ? 'replace' : 'merge'));
});

/* ---------- everything else belongs to one profile ---------- */

router.use(async (req, res, next) => {
    const runtime = await runtimes.get(requestedProfile(req));
    // The bootstrap payload also tells the page which profiles exist.
    if (req.method === 'GET' && req.path === '/bootstrap') {
        const send = res.json.bind(res);
        res.json = (body) => send({ ...body, ...describe(req), profile: { id: runtime.id, name: (runtimes.entryOf(runtime.id) || {}).name } });
    }
    return runtime.router(req, res, next);
});

module.exports = router;
