'use strict';

const { createPool } = require('./connection');
const { importHonourableMentions } = require('./import-workbook-baselines');

async function main() {
    const csvPath = process.argv[2] || 'team_lists.csv';
    const workbookPath = process.argv[3] || process.env.WORKBOOK_PATH;
    if (!workbookPath) {
        throw new Error('Provide a workbook path as the third argument or set WORKBOOK_PATH.');
    }

    const pool = createPool();
    try {
        const result = await importHonourableMentions(pool, csvPath, workbookPath);
        console.log(
            `Imported ${result.mentionRows} Honourable Mentions for ${result.season}.`
        );
        if (result.unmatched.length) {
            console.error(JSON.stringify(result.unmatched, null, 2));
        }
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
