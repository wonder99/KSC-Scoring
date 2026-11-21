'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function buildBackupFilename(now = new Date(), backupDir = path.join(__dirname, '..', 'backups')) {
    const timestamp = now.toISOString()
        .replace(/:/g, '-')
        .replace(/\..*$/, '');
    return path.join(backupDir, `league-${timestamp}.dump`);
}

function createDatabaseBackup({
    databaseUrl = process.env.DATABASE_URL,
    backupDir = path.join(__dirname, '..', 'backups'),
    now = new Date()
} = {}) {
    if (!databaseUrl) throw new Error('DATABASE_URL must be configured.');

    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = buildBackupFilename(now, backupDir);
    const result = spawnSync('pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--dbname', databaseUrl,
        '--file', backupFile
    ], { stdio: 'inherit', env: process.env });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`pg_dump failed with exit code ${result.status}.`);
    }
    if (!fs.existsSync(backupFile) || fs.statSync(backupFile).size === 0) {
        throw new Error('pg_dump completed without creating a backup file.');
    }
    return backupFile;
}

function isValidBackupFilename(filename) {
    return typeof filename === 'string'
        && path.basename(filename) === filename
        && /^league-[^/\\\\]+\.dump$/.test(filename);
}

async function listDatabaseBackups(backupDir = path.join(__dirname, '..', 'backups')) {
    if (!fs.existsSync(backupDir)) return [];
    const entries = await fs.promises.readdir(backupDir, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
        if (!entry.isFile() || !isValidBackupFilename(entry.name)) continue;
        const filePath = path.join(backupDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        backups.push({
            filename: entry.name,
            size: stat.size,
            createdAt: stat.mtime.toISOString()
        });
    }
    return backups.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
    );
}

if (require.main === module) {
    try {
        const backupFile = createDatabaseBackup();
        console.log(`League database backup created: ${backupFile}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    buildBackupFilename,
    createDatabaseBackup,
    isValidBackupFilename,
    listDatabaseBackups
};
