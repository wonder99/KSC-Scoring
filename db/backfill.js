'use strict';

const { createPool } = require('./connection');
const { backfillScoreCsvUploads } = require('./import-score-csv');

function parseCsv(text) {
    const source = String(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let afterQuote = false;

    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (quoted) {
            if (character === '"' && source[index + 1] === '"') {
                field += '"';
                index++;
            } else if (character === '"') {
                quoted = false;
                afterQuote = true;
            } else {
                field += character;
            }
        } else if (character === ',') {
            row.push(field);
            field = '';
            afterQuote = false;
        } else if (character === '\n' || character === '\r') {
            if (character === '\r' && source[index + 1] === '\n') index++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            afterQuote = false;
        } else if (character === '"') {
            if (field.length || afterQuote) throw new Error('Invalid CSV quote.');
            quoted = true;
        } else if (afterQuote) {
            if (!/\s/.test(character)) throw new Error('Unexpected CSV text.');
        } else {
            field += character;
        }
    }
    if (quoted) throw new Error('Unterminated CSV quote.');
    if (field.length || row.length || afterQuote) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

if (require.main === module) {
    const pool = createPool();
    backfillScoreCsvUploads(pool, parseCsv)
        .then(async result => {
            await pool.end();
            console.log(`Backfilled ${result.processed.length} CSV uploads.`);
            if (result.conflicts.length) {
                console.error(
                    `${result.conflicts.length} uploads conflict with existing game winners.`
                );
                for (const conflict of result.conflicts) {
                    console.error(
                        `${conflict.matchDate} board ${conflict.board} ${conflict.team}: ${conflict.error}`
                    );
                }
            }
        })
        .catch(async error => {
            await pool.end().catch(() => {});
            console.error(error);
            process.exitCode = 1;
        });
}

module.exports = { parseCsv };
