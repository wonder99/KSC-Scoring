'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERSION_LABEL = /(<p class="app-version">Version )(\d+)(<\/p>)/;

function incrementVersion(html) {
    let found = false;
    const updated = html.replace(VERSION_LABEL, (_, prefix, version, suffix) => {
        const currentVersion = Number(version);
        if (!Number.isSafeInteger(currentVersion) || currentVersion === Number.MAX_SAFE_INTEGER) {
            throw new Error('The app version is not a safe integer.');
        }
        found = true;
        return `${prefix}${currentVersion + 1}${suffix}`;
    });
    if (!found) throw new Error('Could not find the app version label in index.html.');
    return updated;
}

function bumpVersion() {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const indexPath = path.join(repoRoot, 'index.html');
    const html = fs.readFileSync(indexPath, 'utf8');
    fs.writeFileSync(indexPath, incrementVersion(html), 'utf8');
    execFileSync('git', ['add', '--', 'index.html'], { cwd: repoRoot, stdio: 'inherit' });
}

if (require.main === module) {
    try {
        bumpVersion();
    } catch (error) {
        console.error(`Could not increment app version: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { incrementVersion };
