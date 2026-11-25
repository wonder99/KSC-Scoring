'use strict';

const { startServer } = require('./server');
const path = require('node:path');

startServer({ publicDir: path.join(__dirname, 'site') }).catch(error => {
    console.error('Could not start the KSC Darts League server:', error);
    process.exitCode = 1;
});
