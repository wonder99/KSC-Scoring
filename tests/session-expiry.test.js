'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('persisted match sessions expire from their fixed start timestamp after 24 hours', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

    assert.match(source, /const SESSION_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000;/);
    assert.match(source, /matchStartedAt: state\.matchStartedAt/);
    assert.match(source, /Date\.now\(\) - savedStartedAt >= SESSION_MAX_AGE_MS/);
    assert.match(source, /setTimeout\(resetExpiredSession, remainingMs\)/);
    assert.match(source, /The saved match was older than 24 hours and was cleared\./);
});
