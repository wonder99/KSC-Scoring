'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { backupDatabaseUrl, postgresTool } = require('./postgres-tools');

function buildBackupFilename(now = new Date(), backupDir = path.join(__dirname, '..', 'backups')) {
    const timestamp = now.toISOString()
        .replace(/:/g, '-')
        .replace(/\..*$/, '');
    return path.join(backupDir, `league-${timestamp}.dump`);
}

function createDatabaseBackup({
    databaseUrl,
    backupDir = path.join(__dirname, '..', 'backups'),
    now = new Date()
} = {}) {
    databaseUrl = backupDatabaseUrl(databaseUrl);
    if (!databaseUrl) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be configured.');

    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = buildBackupFilename(now, backupDir);
    const result = spawnSync(postgresTool('pg_dump'), [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--dbname', databaseUrl,
        '--file', backupFile
    ], { encoding: 'utf8', env: process.env });

    if (result.error) {
        if (result.error.code === 'ENOENT') {
            throw new Error(
                'pg_dump is not installed or not available on PATH or in PG_BINDIR in the server environment.'
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
            `pg_dump failed with exit code ${result.status}.${detail ? ` ${detail}` : ''}`
        );
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

function normalizeUploadedBackupFilename(filename, now = new Date()) {
    if (typeof filename !== 'string') {
        throw new Error('A backup filename is required.');
    }
    let basename = path.basename(filename.trim());
    try {
        basename = path.basename(decodeURIComponent(basename));
    } catch {
        // Keep the original sanitized basename.
    }
    const cleaned = basename
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/\.dump$/i, '');
    if (!cleaned) throw new Error('A valid backup filename is required.');
    const timestamp = now.toISOString()
        .replace(/:/g, '-')
        .replace(/\..*$/, '');
    const stem = cleaned.toLowerCase().startsWith('league-')
        ? cleaned
        : `league-upload-${timestamp}-${cleaned}`;
    const normalized = `${stem}.dump`;
    if (!isValidBackupFilename(normalized)) {
        throw new Error('A valid backup filename is required.');
    }
    return normalized;
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
    listDatabaseBackups,
    normalizeUploadedBackupFilename
};
