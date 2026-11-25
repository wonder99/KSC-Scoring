'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('persisted match sessions expire from their fixed start timestamp after 24 hours', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');

    assert.match(source, /const SESSION_MAX_AGE_MS = 24 \* 60 \* 60 \* 1000;/);
    assert.match(source, /matchStartedAt: state\.matchStartedAt/);
    assert.match(source, /Date\.now\(\) - savedStartedAt >= SESSION_MAX_AGE_MS/);
    assert.match(source, /setTimeout\(resetExpiredSession, remainingMs\)/);
    assert.match(source, /The saved match was older than 24 hours and was cleared\./);
});

function createScorer(storage) {
    const source = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf8');
    const eventHandlers = source.indexOf("\n$('match-date').addEventListener");
    assert.notEqual(eventHandlers, -1);

    const elements = new Map();
    const status = { textContent: '', classList: { toggle() {} } };
    const document = {
        cookie: '',
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, {
                    value: '',
                    options: [],
                    textContent: '',
                    classList: { add() {}, remove() {}, toggle() {} },
                    set innerHTML(html) {
                        this.options = [...html.matchAll(/<option value="([^"]*)"/g)]
                            .map(match => ({ value: match[1] }));
                    }
                });
            }
            return elements.get(id);
        },
        querySelectorAll(selector) {
            return selector === '.persistence-status' ? [status] : [];
        }
    };
    const context = vm.createContext({
        document,
        localStorage: storage,
        setTimeout: () => 1,
        clearTimeout: () => {}
    });
    vm.runInContext(source.slice(0, eventHandlers), context);
    vm.runInContext(`
        state.schedule = [{ date: '2026-11-25', board: '1', teams: ['Keepers', 'Bees'] }];
        state.teams.set('keepers', { players: ['Alice', 'Bob', 'Carol', 'Dave'] });
        renderLineup = () => {};
        updateLineupStatus = () => {};
    `, context);
    return { context, status };
}

function createStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key)
    };
}

test('restores an unstarted roster selection and starts its timer on lineup', () => {
    const storage = createStorage();
    const first = createScorer(storage);
    vm.runInContext(`
        populateDates(false);
        $('team-select').value = 'Keepers';
        selectMatch();
    `, first.context);
    const saved = JSON.parse(storage.getItem('ksc-darts-scorer-session'));
    assert.equal(saved.matchStartedAt, null);

    const reloaded = createScorer(storage);
    assert.equal(vm.runInContext('restorePersistedSession()', reloaded.context), true);
    assert.equal(reloaded.status.textContent, '');
    assert.equal(vm.runInContext('state.teamName', reloaded.context), 'Keepers');
    assert.equal(JSON.parse(storage.getItem('ksc-darts-scorer-session')).matchStartedAt, null);

    vm.runInContext('startGame()', reloaded.context);
    const started = JSON.parse(storage.getItem('ksc-darts-scorer-session'));
    assert.equal(started.currentScreen, 'lineup');
    assert.ok(Number.isInteger(started.matchStartedAt));

    const reloadedLineup = createScorer(storage);
    assert.equal(vm.runInContext('restorePersistedSession()', reloadedLineup.context), true);
    assert.equal(reloadedLineup.status.textContent, '');
    assert.equal(vm.runInContext('state.matchStartedAt', reloadedLineup.context), started.matchStartedAt);
});

test('rejects a null start time for a lineup or started game without deleting it', () => {
    const storage = createStorage();
    const scorer = createScorer(storage);
    vm.runInContext(`
        populateDates(false);
        $('team-select').value = 'Keepers';
        selectMatch();
    `, scorer.context);
    const saved = JSON.parse(storage.getItem('ksc-darts-scorer-session'));

    for (const invalid of [
        { ...saved, currentScreen: 'lineup' },
        { ...saved, games: saved.games.map((game, index) => index ? game : { ...game, started: true }) }
    ]) {
        const serialized = JSON.stringify(invalid);
        storage.setItem('ksc-darts-scorer-session', serialized);
        const reloaded = createScorer(storage);
        vm.runInContext('restorePersistedSession()', reloaded.context);
        assert.match(reloaded.status.textContent, /saved match start time is invalid/);
        assert.equal(storage.getItem('ksc-darts-scorer-session'), serialized);
    }
});

test('still clears expired matches and rejects future start times', () => {
    const storage = createStorage();
    const scorer = createScorer(storage);
    vm.runInContext(`
        populateDates(false);
        $('team-select').value = 'Keepers';
        selectMatch();
        startGame();
    `, scorer.context);
    const saved = JSON.parse(storage.getItem('ksc-darts-scorer-session'));

    storage.setItem('ksc-darts-scorer-session', JSON.stringify({
        ...saved, matchStartedAt: Date.now() - 25 * 60 * 60 * 1000
    }));
    const expired = createScorer(storage);
    assert.equal(vm.runInContext('restorePersistedSession()', expired.context), false);
    assert.match(expired.status.textContent, /older than 24 hours/);
    assert.equal(storage.getItem('ksc-darts-scorer-session'), null);

    const future = JSON.stringify({ ...saved, matchStartedAt: Date.now() + 6 * 60 * 1000 });
    storage.setItem('ksc-darts-scorer-session', future);
    const reloaded = createScorer(storage);
    vm.runInContext('restorePersistedSession()', reloaded.context);
    assert.match(reloaded.status.textContent, /saved match start time is invalid/);
    assert.equal(storage.getItem('ksc-darts-scorer-session'), future);
});
