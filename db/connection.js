'use strict';

const { Pool } = require('pg');

function createPool(databaseUrl = process.env.DATABASE_URL) {
    if (!databaseUrl) throw new Error('DATABASE_URL must be configured.');

    const pool = new Pool({ connectionString: databaseUrl });
    pool.on('error', error => {
        console.error('Unexpected PostgreSQL pool error:', error);
    });
    return pool;
}

module.exports = { createPool };
