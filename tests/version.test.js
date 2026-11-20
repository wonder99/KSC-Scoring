'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { incrementVersion } = require('../.githooks/bump-version');

test('increments and stages the landing-page version in a Git repository', () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), '701-club-version-'));
    const hooksPath = path.join(repository, '.githooks');
    try {
        execFileSync('git', ['init', '--quiet'], { cwd: repository });
        execFileSync('git', ['config', 'user.name', 'Version Test'], { cwd: repository });
        execFileSync('git', ['config', 'user.email', 'version-test@example.invalid'], { cwd: repository });
        fs.mkdirSync(hooksPath);
        for (const file of ['pre-commit', 'bump-version.js']) {
            fs.copyFileSync(path.resolve(__dirname, `../.githooks/${file}`), path.join(hooksPath, file));
        }
        fs.chmodSync(path.join(hooksPath, 'pre-commit'), 0o755);
        execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'index.html'), '<p class="app-version">Version 18</p>\n');

        execFileSync('git', ['add', '--', 'index.html'], { cwd: repository });
        execFileSync('git', ['commit', '--quiet', '-m', 'Initial'], { cwd: repository });
        assert.match(execFileSync('git', ['show', 'HEAD:index.html'], {
            cwd: repository,
            encoding: 'utf8'
        }), /Version 19/);

        fs.writeFileSync(path.join(repository, 'unrelated.txt'), 'second commit\n');
        execFileSync('git', ['add', '--', 'unrelated.txt'], { cwd: repository });
        execFileSync('git', ['commit', '--quiet', '-m', 'Unrelated change'], { cwd: repository });
        assert.match(execFileSync('git', ['show', 'HEAD:index.html'], {
            cwd: repository,
            encoding: 'utf8'
        }), /Version 20/);
    } finally {
        fs.rmSync(repository, { recursive: true, force: true });
    }
});

test('fails explicitly when the landing-page version label is missing', () => {
    assert.throws(() => incrementVersion('<p>no version</p>'), /Could not find the app version label/);
});
