'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const server = require('../server');

test('Passenger entry point starts the server when loaded as a module', t => {
    const startServer = t.mock.method(server, 'startServer', async () => {});

    require('../passenger-server');

    assert.equal(startServer.mock.callCount(), 1);
    assert.deepEqual(startServer.mock.calls[0].arguments, [{
        publicDir: path.resolve(__dirname, '../site')
    }]);
});
