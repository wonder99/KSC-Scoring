// Simple script to set environment and start server
const { exec } = require('child_process');

// Set environment variables
process.env.DATABASE_URL = 'postgresql://postgres@localhost/the701club';
process.env.UPLOAD_API_KEY = 'test-key-12345';

// Start the server
const child = exec('node server.js', (error, stdout, stderr) => {
    if (error) {
        console.error(`Server error: ${error}`);
        return;
    }
    console.log(stdout);
    console.error(stderr);
});

child.stdout.on('data', (data) => {
    console.log(data);
});

child.stderr.on('data', (data) => {
    console.error(data);
});