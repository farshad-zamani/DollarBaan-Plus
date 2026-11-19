// Assembles the DollarBaan Plus modules around the upstream cores of one profile.
// Used by the Node server and the in-app backend alike.
import { CashCore } from './cash.js';
import { LocationsCore } from './locations.js';
import { WithdrawalCore } from './withdrawals.js';
import { StocksCore } from './stocks.js';
import { PnlCore } from './pnl.js';
import { HistoryEngine } from './history.js';

/**
 * @param {object} options
 * @param {object} options.store      storage adapter of the profile
 * @param {object} options.market     MarketCore
 * @param {object} options.settings   SettingsCore
 * @param {object} options.portfolio  PlusPortfolioCore
 * @param {object} options.platform   { logger, uuid, fetchJson }
 */
export function createPlus({ store, market, settings, portfolio, platform }) {
    const cash = new CashCore({ store, market, settings, portfolio, platform });
    const locations = new LocationsCore({ store, settings, portfolio });
    const withdrawals = new WithdrawalCore({ store, market, portfolio, cash, platform });
    const stocks = new StocksCore({ store, market, settings, platform });
    const pnl = new PnlCore({ market, portfolio, withdrawals });
    const history = new HistoryEngine({ store, market, settings, platform });
    const plus = { cash, locations, withdrawals, stocks, pnl, history };
    portfolio.attach(plus);

    // A manual refresh (or the app coming back to the foreground) updates stock prices too.
    const baseSync = market.sync.bind(market);
    market.sync = (options = {}) => {
        const run = baseSync(options);
        if (options.reason !== 'manual' && options.reason !== 'resume') return run;
        return Promise.all([run, stocks.sync(options)]).then(([status]) => status);
    };

    // Old prices: reach back as far as a date needs before answering, and say when a price is an estimate.
    const basePriceAt = market.priceAt.bind(market);
    market.priceAt = async (symbol, date) => {
        await history.ensureCoverage(symbol, date);
        const result = await basePriceAt(symbol, date);
        const info = result && result.date ? history.describe(symbol, result.date) : null;
        return info ? { ...result, ...info } : result;
    };
    const baseTrackNow = market.trackNow.bind(market);
    market.trackNow = async (symbols) => {
        await baseTrackNow(symbols);
        await history.trackNow(symbols);
    };

    let unsubscribe = null;

    return {
        ...plus,
        /** Call once after market.init(): the built-in cash asset and stock state. */
        async init() {
            await stocks.init();
            await cash.ensureAsset();
        },
        start() {
            stocks.start();
            const backfill = () => history.backfillHeld().catch(() => {});
            backfill();
            if (!unsubscribe) unsubscribe = market.on('synced', backfill);
        },
        stop() {
            stocks.stop();
            if (unsubscribe) unsubscribe();
            unsubscribe = null;
        },
        /** Extra fields for the status payload. */
        statusExtras() {
            return { stocks: stocks.publicStatus() };
        },
    };
}
