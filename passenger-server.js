'use strict';

const { startServer } = require('./server');

startServer().catch(error => {
    console.error('Could not start the KSC Darts League server:', error);
    process.exitCode = 1;
});
