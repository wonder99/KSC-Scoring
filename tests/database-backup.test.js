'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pooledUrl = 'postgresql://test:dummy@ep-example-pooler.region.aws.neon.tech/test';
const directUrl = 'postgresql://test:dummy@ep-example.region.aws.neon.tech/test';

function setDatabaseUrls(t, pooled, direct) {
    const previous = {
        DATABASE_URL: process.env.DATABASE_URL,
        DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
        PG_BINDIR: process.env.PG_BINDIR
    };
    for (const [key, value] of Object.entries({
        DATABASE_URL: pooled,
        DATABASE_URL_UNPOOLED: direct,
        PG_BINDIR: undefined
    })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

function loadTools(t, spawn) {
    t.mock.method(childProcess, 'spawnSync', spawn);
    for (const name of ['../db/backup', '../db/restore']) {
        delete require.cache[require.resolve(name)];
    }
    t.after(() => {
        for (const name of ['../db/backup', '../db/restore']) {
            delete require.cache[require.resolve(name)];
        }
    });
    return {
        backup: require('../db/backup'),
        restore: require('../db/restore')
    };
}

function tempDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'league-backup-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('backup uses the direct URL and produces the existing custom archive format', t => {
    setDatabaseUrls(t, pooledUrl, directUrl);
    const directory = tempDirectory(t);
    const calls = [];
    const { backup } = loadTools(t, (command, args, options) => {
        calls.push({ command, args, options });
        fs.writeFileSync(args[args.indexOf('--file') + 1], 'fake archive');
        return { status: 0 };
    });
    const file = backup.createDatabaseBackup({
        backupDir: directory,
        now: new Date('2026-01-02T03:04:05Z')
    });

    assert.equal(path.basename(file), 'league-2026-01-02T03-04-05.dump');
    assert.equal(fs.readFileSync(file, 'utf8'), 'fake archive');
    assert.equal(calls[0].command, 'pg_dump');
    assert.deepEqual(calls[0].args, [
        '--format=custom', '--no-owner', '--no-privileges',
        '--dbname', directUrl, '--file', file
    ]);
    assert.equal(calls[0].options.env, process.env);
});

test('backup and restore fall back to DATABASE_URL and honor explicit URLs', t => {
    setDatabaseUrls(t, directUrl, undefined);
    const directory = tempDirectory(t);
    const calls = [];
    const { backup, restore } = loadTools(t, (command, args) => {
        calls.push({ command, args });
        if (command === 'pg_dump') {
            fs.writeFileSync(args[args.indexOf('--file') + 1], 'fake archive');
        }
        return { status: 0 };
    });
    const file = backup.createDatabaseBackup({ backupDir: directory });
    restore.restoreDatabaseBackup({ backupFile: file, confirmed: true });
    assert.equal(calls[0].args[calls[0].args.indexOf('--dbname') + 1], directUrl);
    assert.equal(calls[1].args[calls[1].args.indexOf('--dbname') + 1], directUrl);
    assert.deepEqual(calls[1].args, [
        '--clean', '--if-exists', '--no-owner', '--no-privileges',
        '--dbname', directUrl, path.resolve(file)
    ]);

    process.env.DATABASE_URL_UNPOOLED = directUrl;
    const explicit = 'postgresql://test:dummy@localhost:1/explicit';
    backup.createDatabaseBackup({ backupDir: directory, databaseUrl: explicit });
    restore.restoreDatabaseBackup({ backupFile: file, confirmed: true, databaseUrl: explicit });
    assert.equal(calls[2].args[calls[2].args.indexOf('--dbname') + 1], explicit);
    assert.equal(calls[3].args[calls[3].args.indexOf('--dbname') + 1], explicit);
});

test('mismatched targets and pooled-only Neon are rejected before invoking tools', t => {
    setDatabaseUrls(t, 'postgresql://test:dummy@render.example/test', directUrl);
    const directory = tempDirectory(t);
    const file = path.join(directory, 'league-existing.dump');
    fs.writeFileSync(file, 'fake archive');
    let calls = 0;
    const { backup, restore } = loadTools(t, () => { calls += 1; return { status: 0 }; });
    for (const candidate of [
        directUrl,
        'postgresql://other:dummy@render.example/test',
        'postgresql://test:dummy@render.example/other',
        'postgresql://test:dummy@render.example:5433/test',
        'postgresql://test:dummy@render.example/test?host=other',
        'postgresql://test:dummy@render.example/test?options=endpoint%3Dother'
    ]) {
        process.env.DATABASE_URL_UNPOOLED = candidate;
        assert.throws(() => backup.createDatabaseBackup({ backupDir: directory }), /does not match/);
        assert.throws(
            () => restore.restoreDatabaseBackup({ backupFile: file, confirmed: true }),
            /does not match/
        );
    }
    process.env.DATABASE_URL = pooledUrl;
    delete process.env.DATABASE_URL_UNPOOLED;
    assert.throws(() => backup.createDatabaseBackup({ backupDir: directory }), /direct Neon connection/);
    assert.equal(calls, 0);
    restore.restoreDatabaseBackup({ backupFile: file, confirmed: true, databaseUrl: directUrl });
    assert.equal(calls, 1);
});

test('PG_BINDIR selects the installed tools even when PATH does not', t => {
    setDatabaseUrls(t, directUrl, undefined);
    const directory = tempDirectory(t);
    process.env.PG_BINDIR = path.join(directory, 'PostgreSQL 18', 'bin');
    const commands = [];
    const { backup, restore } = loadTools(t, (command, args) => {
        commands.push(command);
        if (args.includes('--file')) fs.writeFileSync(args[args.indexOf('--file') + 1], 'archive');
        return { status: 0 };
    });
    const file = backup.createDatabaseBackup({ backupDir: directory });
    restore.restoreDatabaseBackup({ backupFile: file, confirmed: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    assert.deepEqual(commands, [
        path.join(process.env.PG_BINDIR, `pg_dump${suffix}`),
        path.join(process.env.PG_BINDIR, `pg_restore${suffix}`)
    ]);
});

test('restore requires confirmation and reports missing client tools', t => {
    setDatabaseUrls(t, pooledUrl, directUrl);
    const directory = tempDirectory(t);
    const file = path.join(directory, 'league-existing.dump');
    fs.writeFileSync(file, 'fake archive');
    let calls = 0;
    const { backup, restore } = loadTools(t, () => {
        calls += 1;
        return { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) };
    });
    assert.throws(() => restore.restoreDatabaseBackup({ backupFile: file }), /confirm=RESTORE/);
    assert.equal(calls, 0);
    assert.throws(() => backup.createDatabaseBackup({ backupDir: directory }), /pg_dump.*PATH/);
    assert.throws(
        () => restore.restoreDatabaseBackup({ backupFile: file, confirmed: true }),
        /pg_restore.*PATH/
    );
});

test('direct-only configuration works and command failures remain visible', t => {
    setDatabaseUrls(t, undefined, directUrl);
    const directory = tempDirectory(t);
    const file = path.join(directory, 'league-existing.dump');
    fs.writeFileSync(file, 'fake archive');
    const calls = [];
    const { backup, restore } = loadTools(t, (command, args) => {
        calls.push({ command, args });
        return { status: 1, stderr: 'simulated failure' };
    });
    assert.throws(
        () => backup.createDatabaseBackup({ backupDir: directory }),
        /pg_dump failed with exit code 1.*simulated failure/
    );
    assert.throws(
        () => restore.restoreDatabaseBackup({ backupFile: file, confirmed: true }),
        /pg_restore failed with exit code 1.*simulated failure/
    );
    assert.deepEqual(calls.map(call => call.args[call.args.indexOf('--dbname') + 1]), [
        directUrl, directUrl
    ]);

    delete process.env.DATABASE_URL_UNPOOLED;
    assert.throws(() => backup.createDatabaseBackup({ backupDir: directory }), /must be configured/);
    assert.throws(
        () => restore.restoreDatabaseBackup({ backupFile: file, confirmed: true }),
        /must be configured/
    );
    assert.equal(calls.length, 2);
});

test('admin can create, download, and restore an archive using the direct URL', async t => {
    setDatabaseUrls(t, pooledUrl, directUrl);
    const backupDir = tempDirectory(t);
    const calls = [];
    loadTools(t, (command, args) => {
        calls.push({ command, args });
        if (command === 'pg_dump') {
            const file = args[args.indexOf('--file') + 1];
            fs.writeFileSync(file, 'fake custom archive', { flag: 'wx' });
        }
        return { status: 0 };
    });

    const { createServer } = require('../server');
    const server = createServer({
        pool: { query: async () => ({ rows: [] }) },
        uploadApiKey: 'test-upload',
        adminApiKey: 'test-admin',
        backupDir
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/backups`;
    const auth = { Authorization: 'Bearer test-admin' };

    const unauthorized = await fetch(`${url}/create`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.length, 0);
    const created = await fetch(`${url}/create`, { method: 'POST', headers: auth });
    assert.equal(created.status, 201);
    const { backup } = await created.json();
    const download = await fetch(`${url}/download?file=${encodeURIComponent(backup.filename)}`, {
        headers: auth
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'fake custom archive');

    const restore = await fetch(`${url}/restore`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: backup.filename, confirmation: 'RESTORE' })
    });
    assert.equal(restore.status, 200);
    assert.deepEqual(await restore.json(), { restored: true, filename: backup.filename });
    assert.deepEqual(calls.map(call => call.command), ['pg_dump', 'pg_restore']);
    for (const call of calls) {
        assert.equal(call.args[call.args.indexOf('--dbname') + 1], directUrl);
    }
});
