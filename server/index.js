'use strict';

const config = require('./config');
const logger = require('./logger');
const { sequelize, initDatabase } = require('./db');
const { settings } = require('./services/settings');
const { market } = require('./services/market');
const plus = require('./services/plus');
const runtimes = require('./services/runtimes');
const auth = require('./services/auth');
const { migrateLegacyData, detectPendingMigration } = require('./services/legacy');
const { createApp } = require('./app');

async function main() {
    await initDatabase();
    await settings.load();
    await market.init();
    await plus.init();
    if (await detectPendingMigration()) logger.info('DollarBaan 1.x data found; it will be imported after the first price sync');

    const app = createApp();
    const server = await new Promise((resolve, reject) => {
        // Express 5 also calls this when binding fails (with the error); treating that as "listening"
        // would let the process exit silently, so a bind error is rejected and reported below.
        const onListening = (error) => (error ? reject(error) : resolve(instance));
        const instance = config.host
            ? app.listen(config.port, config.host, onListening)
            : app.listen(config.port, onListening);
        instance.once('error', reject);
    });
    logger.info(`DollarBaan Plus ${config.version} is up and running on port ${config.port}`);
    if (auth.usesDefaultPassword()) {
        logger.warn('You are using the default password "changeit". Change it from Settings or set AUTH_PASSWORD in .env.');
    }

    market.on('synced', () => migrateLegacyData());
    if (market.assets.size > 0) migrateLegacyData();
    // Price updates of every profile (the main one first).
    await runtimes.startAll();
    auth.startSessionCleanup();

    let closing = false;
    const shutdown = (signal) => {
        if (closing) return;
        closing = true;
        logger.info(`${signal} received, shutting down`);
        runtimes.stopAll();
        market.stop();
        plus.stop();
        server.close(() => {
            Promise.all([runtimes.closeAll(), sequelize.close()]).finally(() => process.exit(0));
        });
        setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
    if (error && error.code === 'EADDRINUSE') {
        logger.error(`Port ${config.port} is already in use. Stop the other process or set PORT in .env.`);
    } else if (error && error.code === 'EACCES') {
        logger.error(`Port ${config.port} cannot be used (it needs administrator rights or is reserved by the system). Set another PORT in .env.`);
    } else {
        logger.error(`Startup failed: ${error && error.stack ? error.stack : error}`);
    }
    process.exit(1);
});
