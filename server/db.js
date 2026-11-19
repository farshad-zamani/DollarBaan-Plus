'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const config = require('./config');
const logger = require('./logger');

// DollarBaan Plus keeps every profile in its own database so profiles share nothing:
// the default profile uses the configured database, others use "<name>-<id>" (SQLite file or MySQL schema).
function createSequelize({ storage = config.db.storage, name = config.db.name } = {}) {
    const { db } = config;
    if (db.dialect === 'sqlite') {
        return new Sequelize({ dialect: 'sqlite', storage, logging: false });
    }
    if (db.dialect !== 'mysql' && db.dialect !== 'mariadb') {
        throw new Error(`Unsupported DB_DIALECT "${db.dialect}". Use "sqlite" or "mysql".`);
    }
    // mysql2 also talks to MariaDB, so both values use the mysql dialect.
    return new Sequelize(name, db.user, db.password, {
        host: db.host,
        port: db.port,
        dialect: 'mysql',
        logging: false,
        pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
        dialectOptions: { decimalNumbers: true },
        define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
    });
}

const LONG_TEXT = config.db.dialect === 'sqlite' ? DataTypes.TEXT : DataTypes.TEXT('long');

function defineModels(sequelize) {

    const Setting = sequelize.define('Setting', {
        key: { type: DataTypes.STRING(64), primaryKey: true },
        value: { type: LONG_TEXT, allowNull: true },
    }, { tableName: 'settings' });

    // Every priced thing: market quotes (one row per symbol) and the user's custom assets.
    const Asset = sequelize.define('Asset', {
        symbol: { type: DataTypes.STRING(64), primaryKey: true },
        source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'market' },
        provider: { type: DataTypes.STRING(32), allowNull: true },
        nameFa: { type: DataTypes.STRING(191), allowNull: false },
        nameEn: { type: DataTypes.STRING(191), allowNull: true },
        category: { type: DataTypes.STRING(32), allowNull: false },
        currency: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'IRT' },
        unit: { type: DataTypes.STRING(32), allowNull: true },
        price: { type: DataTypes.DOUBLE, allowNull: true },
        prevClose: { type: DataTypes.DOUBLE, allowNull: true },
        high: { type: DataTypes.DOUBLE, allowNull: true },
        low: { type: DataTypes.DOUBLE, allowNull: true },
        quoteTime: { type: DataTypes.DATE, allowNull: true },
        stale: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        listed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        rateSymbol: { type: DataTypes.STRING(64), allowNull: true },
        meta: { type: DataTypes.TEXT, allowNull: true },
    }, {
        tableName: 'assets',
        indexes: [{ fields: ['provider'] }, { fields: ['source'] }],
    });

    const Transaction = sequelize.define('Transaction', {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        symbol: { type: DataTypes.STRING(64), allowNull: false },
        side: { type: DataTypes.STRING(8), allowNull: false },
        quantity: { type: DataTypes.DOUBLE, allowNull: false },
        unitPrice: { type: DataTypes.DOUBLE, allowNull: false },
        fee: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
        date: { type: DataTypes.DATEONLY, allowNull: false },
        note: { type: DataTypes.TEXT, allowNull: true },
        // DollarBaan Plus: where the asset is kept, where cash came from, and links between rows.
        location: { type: DataTypes.STRING(80), allowNull: true },
        sourceId: { type: DataTypes.STRING(64), allowNull: true },
        kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'trade' },
        linkId: { type: DataTypes.STRING(64), allowNull: true },
        withdrawalId: { type: DataTypes.STRING(64), allowNull: true },
    }, {
        tableName: 'transactions',
        indexes: [{ fields: ['symbol'] }, { fields: ['date'] }],
    });

    // Daily candles in the asset's own currency (toman, or USD for global assets).
    const PricePoint = sequelize.define('PricePoint', {
        symbol: { type: DataTypes.STRING(64), primaryKey: true },
        date: { type: DataTypes.DATEONLY, primaryKey: true },
        open: { type: DataTypes.DOUBLE, allowNull: true },
        high: { type: DataTypes.DOUBLE, allowNull: true },
        low: { type: DataTypes.DOUBLE, allowNull: true },
        close: { type: DataTypes.DOUBLE, allowNull: false },
        origin: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'provider' },
    }, { tableName: 'price_history', timestamps: false });

    const Session = sequelize.define('Session', {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        username: { type: DataTypes.STRING(191), allowNull: false },
        expiresAt: { type: DataTypes.DATE, allowNull: false },
        lastSeenAt: { type: DataTypes.DATE, allowNull: true },
        userAgent: { type: DataTypes.STRING(255), allowNull: true },
        ip: { type: DataTypes.STRING(64), allowNull: true },
    }, {
        tableName: 'sessions',
        indexes: [{ fields: ['expiresAt'] }],
    });

    // Generic documents (cash sources, profit withdrawals, ...): the whole document is JSON in `body`.
    const Doc = sequelize.define('Doc', {
        id: { type: DataTypes.STRING(64), primaryKey: true },
        type: { type: DataTypes.STRING(32), allowNull: false },
        body: { type: LONG_TEXT, allowNull: false },
    }, {
        tableName: 'docs',
        indexes: [{ fields: ['type'] }],
    });

    return { Setting, Asset, Transaction, PricePoint, Session, Doc };
}


/** Adds columns that models gained after a table was first created (sync() never alters tables). */
async function ensureColumns(sequelize) {
    const queryInterface = sequelize.getQueryInterface();
    for (const model of Object.values(sequelize.models)) {
        const table = model.getTableName();
        const existing = await queryInterface.describeTable(table);
        for (const [name, attribute] of Object.entries(model.rawAttributes)) {
            if (existing[attribute.field || name]) continue;
            await queryInterface.addColumn(table, attribute.field || name, { ...attribute, primaryKey: false, unique: false });
        }
    }
}

async function ensureMysqlDatabase(name) {
    const { db } = config;
    const admin = new Sequelize('', db.user, db.password, { host: db.host, port: db.port, dialect: 'mysql', logging: false });
    try {
        await admin.query('CREATE DATABASE IF NOT EXISTS `' + name.replace(/`/g, '') + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    } finally {
        await admin.close();
    }
}

/** One database with all its models; `name` and `storage` select a profile's own database. */
function createDatabase(options = {}) {
    const sequelize = createSequelize(options);
    const models = defineModels(sequelize);
    const label = config.db.dialect === 'sqlite' ? options.storage || config.db.storage : options.name || config.db.name;

    async function init() {
        if (config.db.dialect !== 'sqlite' && options.name && options.name !== config.db.name) await ensureMysqlDatabase(options.name);
        await sequelize.authenticate();
        // Creates missing tables only; tables from DollarBaan 1.x are left untouched.
        await sequelize.sync();
        await ensureColumns(sequelize);
        if (config.db.dialect === 'sqlite') logger.info(`Using SQLite database at ${label}`);
        else logger.info(`Using MySQL database "${label}" on ${config.db.host}:${config.db.port}`);
    }

    async function listTables() {
        const tables = await sequelize.getQueryInterface().showAllTables();
        return tables.map((table) => (typeof table === 'string' ? table : table.tableName || table.name));
    }

    return { sequelize, ...models, initDatabase: init, listTables, close: () => sequelize.close() };
}

// The default profile's database, exactly as in upstream DollarBaan.
const main = createDatabase();
const { sequelize, Setting, Asset, Transaction, PricePoint, Session, Doc, initDatabase, listTables } = main;

module.exports = {
    sequelize,
    Setting,
    Asset,
    Transaction,
    PricePoint,
    Session,
    Doc,
    initDatabase,
    listTables,
    createDatabase,
};
