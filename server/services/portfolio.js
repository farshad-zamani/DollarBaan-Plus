'use strict';

const config = require('../config');
const store = require('../store');
const platform = require('../platform');
const { settings } = require('./settings');
const { market } = require('./market');
const { plus } = require('../shared');

module.exports = new plus.portfolio.PlusPortfolioCore({ store, market, settings, platform, version: config.version });
