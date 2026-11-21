'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function runMigrations(pool, migrationsDir = path.join(__dirname, '..', 'migrations')) {
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('A PostgreSQL pool is required.');
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const migrations = entries
        .filter(entry => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
        .map(entry => ({
            version: entry.name.slice(0, entry.name.indexOf('_')),
            name: entry.name,
            filePath: path.join(migrationsDir, entry.name)
        }))
        .sort((left, right) => left.version.localeCompare(right.version, undefined, {
            numeric: true
        }));

    const applied = await pool.query(
        'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(applied.rows.map(row => row.version));

    for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) continue;

        const sql = await fs.readFile(migration.filePath, 'utf8');
        const client = typeof pool.connect === 'function' ? await pool.connect() : null;
        const executor = client || pool;
        try {
            await executor.query('BEGIN');
            await executor.query(
                "SELECT pg_advisory_xact_lock(hashtext('701-club-league-migrations'))"
            );
            await executor.query(sql);
            await executor.query(
                `INSERT INTO schema_migrations (version, name)
                 VALUES ($1, $2)
                 ON CONFLICT (version) DO NOTHING`,
                [migration.version, migration.name]
            );
            await executor.query('COMMIT');
            appliedVersions.add(migration.version);
        } catch (error) {
            await executor.query('ROLLBACK');
            throw error;
        } finally {
            if (client) client.release();
        }
    }

    return migrations
        .filter(migration => appliedVersions.has(migration.version))
        .map(migration => migration.name);
}

module.exports = { runMigrations };

if (require.main === module) {
    const { createPool } = require('./connection');
    const pool = createPool();
    runMigrations(pool)
        .then(async migrations => {
            await pool.end();
            console.log(
                migrations.length
                    ? `League migrations complete: ${migrations.join(', ')}`
                    : 'League database is already current.'
            );
        })
        .catch(async error => {
            await pool.end().catch(() => {});
            console.error(error);
            process.exitCode = 1;
        });
}
