'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const server = require('../server');

test('Passenger entry point starts the server when loaded as a module', t => {
    const startServer = t.mock.method(server, 'startServer', async () => {});

    require('../passenger-server');

    assert.equal(startServer.mock.callCount(), 1);
});
