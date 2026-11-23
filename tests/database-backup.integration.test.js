'use strict';

require('dotenv').config({ path: ['.env.local', '.env'] });

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabaseBackup } = require('../db/backup');
const { restoreDatabaseBackup } = require('../db/restore');

const postgresBin = process.env.BACKUP_TEST_POSTGRES_BIN;

test('real PostgreSQL custom archive round trip on a disposable local cluster', {
    skip: !postgresBin && 'Set BACKUP_TEST_POSTGRES_BIN to a PostgreSQL bin directory.'
}, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'league-pg-roundtrip-'));
    const data = path.join(root, 'data');
    const logfile = path.join(root, 'postgres.log');
    const originalEnv = { ...process.env };
    let started = false;
    const executable = name => path.join(postgresBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    const run = (name, args, quiet = false) => {
        const result = spawnSync(executable(name), args, {
            encoding: 'utf8',
            // The server started by pg_ctl can inherit open pipes on Windows.
            stdio: quiet ? 'ignore' : 'pipe'
        });
        assert.ifError(result.error);
        const log = quiet && fs.existsSync(logfile) ? fs.readFileSync(logfile, 'utf8') : '';
        assert.equal(result.status, 0, `${name} failed:\n${result.stderr || ''}\n${result.stdout || ''}\n${log}`);
        return (result.stdout || '').trim();
    };

    try {
        // Never inherit a real database target or connection options.
        for (const key of Object.keys(process.env)) {
            if (/^PG/i.test(key)) delete process.env[key];
        }
        process.env.PG_BINDIR = postgresBin;

        const port = await new Promise((resolve, reject) => {
            const socket = net.createServer();
            socket.once('error', reject);
            socket.listen(0, '127.0.0.1', () => {
                const selected = socket.address().port;
                socket.close(error => error ? reject(error) : resolve(selected));
            });
        });

        run('initdb', ['-D', data, '--username=backup_test', '--auth=trust', '--no-instructions']);
        started = true;
        run('pg_ctl', ['-D', data, '-l', logfile, '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], true);
        const url = `postgresql://backup_test@127.0.0.1:${port}/postgres?sslmode=disable`;
        const psql = sql => run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-d', url, '-c', sql]);
        psql("CREATE TABLE backup_probe (value text); INSERT INTO backup_probe VALUES ('round trip');");

        process.env.DATABASE_URL = url;
        process.env.DATABASE_URL_UNPOOLED = url;
        const file = createDatabaseBackup({ backupDir: root });
        assert.equal(fs.readFileSync(file).subarray(0, 5).toString(), 'PGDMP');

        const { createServer } = require('../server');
        const backupDir = path.join(root, 'web-backups');
        const server = createServer({
            pool: { query: async () => ({ rows: [] }) },
            uploadApiKey: 'test-upload',
            adminApiKey: 'test-admin',
            backupDir
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        let downloaded;
        try {
            const base = `http://127.0.0.1:${server.address().port}/api/admin/backups`;
            const headers = { Authorization: 'Bearer test-admin' };
            const created = await fetch(`${base}/create`, { method: 'POST', headers });
            assert.equal(created.status, 201);
            const { backup } = await created.json();
            const response = await fetch(`${base}/download?file=${encodeURIComponent(backup.filename)}`, { headers });
            assert.equal(response.status, 200);
            downloaded = Buffer.from(await response.arrayBuffer());
            assert.equal(downloaded.subarray(0, 5).toString(), 'PGDMP');
            assert.deepEqual(downloaded, fs.readFileSync(path.join(backupDir, backup.filename)));
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
        const downloadedFile = path.join(root, 'downloaded.dump');
        fs.writeFileSync(downloadedFile, downloaded);
        psql('DROP TABLE backup_probe');
        assert.equal(restoreDatabaseBackup({ backupFile: downloadedFile, confirmed: true }), downloadedFile);
        assert.equal(psql('SELECT value FROM backup_probe'), 'round trip');
    } finally {
        let clusterStopped = true;
        try {
            if (started && fs.existsSync(path.join(data, 'postmaster.pid'))) {
                clusterStopped = false;
                run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
                clusterStopped = true;
            }
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
            if (clusterStopped) fs.rmSync(root, { recursive: true, force: true });
            else console.error(`Disposable test cluster may still be running: ${data}`);
        }
    }
});
