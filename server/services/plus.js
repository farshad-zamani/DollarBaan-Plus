'use strict';

// DollarBaan Plus modules (cash, stocks, withdrawals, profit and loss) of the default profile.
const store = require('../store');
const platform = require('../platform');
const { settings } = require('./settings');
const { market } = require('./market');
const portfolio = require('./portfolio');
const { plus } = require('../shared');

module.exports = plus.runtime.createPlus({ store, market, settings, portfolio, platform });
