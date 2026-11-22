'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseRestoreArguments(args) {
    const confirm = args.find(arg => arg.startsWith('--confirm='));
    const fileArg = args.find(arg => arg.startsWith('--file='));
    const backupFile = fileArg
        ? fileArg.slice('--file='.length)
        : args.find(arg => !arg.startsWith('--'));
    return {
        backupFile,
        confirmed: confirm?.slice('--confirm='.length) === 'RESTORE'
    };
}

function restoreDatabaseBackup({
    databaseUrl = process.env.DATABASE_URL,
    backupFile,
    confirmed = false
} = {}) {
    if (!databaseUrl) throw new Error('DATABASE_URL must be configured.');
    if (!backupFile) throw new Error('Provide --file=path/to/backup.dump.');
    if (!confirmed) {
        throw new Error('Restore requires --confirm=RESTORE.');
    }

    const resolvedFile = path.resolve(backupFile);
    if (!fs.existsSync(resolvedFile) || !fs.statSync(resolvedFile).isFile()) {
        throw new Error(`Backup file not found: ${resolvedFile}`);
    }

    const result = spawnSync('pg_restore', [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '--dbname', databaseUrl,
        resolvedFile
    ], { encoding: 'utf8', env: process.env });

    if (result.error) {
        if (result.error.code === 'ENOENT') {
            throw new Error(
                'pg_restore is not installed or not available on PATH in the server environment.'
            );
        }
        throw result.error;
    }
    if (result.status !== 0) {
        const detail = [
            result.stderr,
            result.stdout
        ].filter(Boolean).join('\n').trim();
        throw new Error(
            `pg_restore failed with exit code ${result.status}.${detail ? ` ${detail}` : ''}`
        );
    }
    return resolvedFile;
}

if (require.main === module) {
    try {
        const parsed = parseRestoreArguments(process.argv.slice(2));
        const restoredFile = restoreDatabaseBackup({
            backupFile: parsed.backupFile,
            confirmed: parsed.confirmed
        });
        console.log(`League database restored from: ${restoredFile}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { parseRestoreArguments, restoreDatabaseBackup };
