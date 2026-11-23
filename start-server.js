const { spawn } = require('node:child_process');

require('dotenv').config({ path: ['.env.local', '.env'] });

const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: process.env,
    stdio: 'inherit'
});

child.on('error', (error) => {
    console.error(`Server error: ${error.message}`);
});