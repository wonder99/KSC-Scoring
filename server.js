'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const MAX_CSV_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_EXPORT_UPLOADS = 100;
const MAX_EXPORT_CSV_BYTES = 10 * 1024 * 1024;
const PUBLIC_FILES = new Set([
    'app.js',
    'dart_league_schedule.csv',
    'index.html',
    'results-csv.js',
    'styles.css',
    'team_lists.csv',
    'uploads.html',
    'uploads.js',
    'user-guide.html'
]);
const CONTENT_TYPES = {
    '.csv': 'text/csv; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
};

class RequestError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

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
            if (field.length || afterQuote) throw new RequestError(400, 'The CSV contains an invalid quote.');
            quoted = true;
        } else if (afterQuote) {
            if (!/\s/.test(character)) throw new RequestError(400, 'Unexpected text after a quoted CSV field.');
        } else {
            field += character;
        }
    }

    if (quoted) throw new RequestError(400, 'The CSV contains an unterminated quoted field.');
    if (field.length || row.length || afterQuote) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function formatDatabaseDate(value) {
    if (!(value instanceof Date)) return String(value).slice(0, 10);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function validateScoreCsv(csvText) {
    const rows = parseCsv(csvText).filter(row => !row.every(value => !value.trim()));
    if (rows.length < 2) throw new RequestError(400, 'The CSV must include a header and at least one score row.');

    const header = rows[0].map(value => value.trim());
    const requiredHeader = ['match_date', 'board', 'game', 'team', 'opponent', 'winner', 'player'];
    if (requiredHeader.some((column, index) => header[index] !== column) ||
        header[header.length - 1] !== 'Checkout' ||
        header.slice(requiredHeader.length, -1).some((column, index) => column !== `round_${index + 1}`)) {
        throw new RequestError(400, 'The CSV header does not match the 701 results format.');
    }

    let fixture = null;
    let rowCount = 0;
    const gamePlayers = new Map();
    for (const rawRow of rows.slice(1)) {
        const row = rawRow.map(value => value.trim());
        if (row.length !== header.length) throw new RequestError(400, 'A CSV row has the wrong number of columns.');

        const [matchDate, board, gameText, team, opponent, winner, player] = row;
        const game = Number(gameText);
        if (!isValidDate(matchDate) || !board || !team || !opponent || !player ||
            !Number.isInteger(game) || game < 1 || game > 7 ||
            (winner !== team && winner !== opponent)) {
            throw new RequestError(400, 'A CSV row contains invalid match or player data.');
        }

        const key = `${matchDate}\u0000${board}\u0000${team}`;
        if (fixture && fixture.key !== key) {
            throw new RequestError(400, 'A CSV upload must contain results for one match and team only.');
        }
        if (!fixture) fixture = { key, matchDate, board, team, opponent };
        if (fixture.opponent !== opponent) throw new RequestError(400, 'The opponent must be consistent throughout the CSV.');

        for (const score of row.slice(requiredHeader.length, -1)) {
            if (score && (!/^\d+$/.test(score) || Number(score) > 180)) {
                throw new RequestError(400, 'A CSV round score must be between 0 and 180.');
            }
        }
        const players = gamePlayers.get(game) || new Set();
        if (players.has(player) || players.size >= 4) {
            throw new RequestError(400, 'Each game can contain up to four unique players.');
        }
        players.add(player);
        gamePlayers.set(game, players);
        rowCount++;
    }

    return { ...fixture, rowCount };
}

function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
}

function isAuthorized(request, expectedKey) {
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(expectedKey);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function readRequestBody(request, maxBytes, tooLargeMessage) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) {
            tooLarge = true;
            chunks.length = 0;
        } else if (!tooLarge) {
            chunks.push(chunk);
        }
    }
    if (tooLarge) throw new RequestError(413, tooLargeMessage);
    return Buffer.concat(chunks).toString('utf8');
}

function readCsvBody(request) {
    return readRequestBody(request, MAX_CSV_BYTES, 'The CSV exceeds the 1 MB upload limit.');
}

async function readJsonBody(request) {
    const body = await readRequestBody(request, MAX_JSON_BYTES, 'The request exceeds the 64 KB limit.');
    try {
        return JSON.parse(body);
    } catch {
        throw new RequestError(400, 'The request body must be valid JSON.');
    }
}

function validateUploadSelection(selection) {
    if (!Array.isArray(selection) || selection.length === 0) {
        throw new RequestError(400, 'Select at least one upload to export.');
    }
    if (selection.length > MAX_EXPORT_UPLOADS) {
        throw new RequestError(400, `Select no more than ${MAX_EXPORT_UPLOADS} uploads at a time.`);
    }

    const keys = new Set();
    return selection.map(item => {
        if (!item || typeof item !== 'object' ||
            !isValidDate(item.matchDate) ||
            typeof item.board !== 'string' || !item.board.trim() ||
            typeof item.team !== 'string' || !item.team.trim()) {
            throw new RequestError(400, 'An upload selection contains invalid match details.');
        }
        const key = `${item.matchDate}\u0000${item.board}\u0000${item.team}`;
        if (keys.has(key)) throw new RequestError(400, 'An upload was selected more than once.');
        keys.add(key);
        return { matchDate: item.matchDate, board: item.board, team: item.team };
    });
}

async function handleUploadList(request, response, { pool, uploadApiKey }) {
    if (!isAuthorized(request, uploadApiKey)) {
        request.resume();
        sendJson(response, 401, { error: 'A valid league upload key is required.' });
        return;
    }
    if (request.method !== 'GET') {
        request.resume();
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
    }

    const result = await pool.query(
        `SELECT match_date, board, team, opponent, row_count, uploaded_at
         FROM score_csv_uploads
         ORDER BY match_date DESC, board, team`
    );
    sendJson(response, 200, {
        uploads: result.rows.map(row => ({
            matchDate: formatDatabaseDate(row.match_date),
            board: row.board,
            team: row.team,
            opponent: row.opponent,
            rowCount: row.row_count,
            uploadedAt: row.uploaded_at
        }))
    });
}

async function handleUploadExport(request, response, { pool, uploadApiKey }) {
    if (!isAuthorized(request, uploadApiKey)) {
        request.resume();
        sendJson(response, 401, { error: 'A valid league upload key is required.' });
        return;
    }
    if (request.method !== 'POST') {
        request.resume();
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        request.resume();
        sendJson(response, 415, { error: 'Content-Type must be application/json.' });
        return;
    }

    const body = await readJsonBody(request);
    const selection = validateUploadSelection(body && body.uploads);
    const values = [];
    const predicates = selection.map((upload, index) => {
        const offset = index * 3;
        values.push(upload.matchDate, upload.board, upload.team);
        return `(match_date = $${offset + 1} AND board = $${offset + 2} AND team = $${offset + 3})`;
    });
    const result = await pool.query(
        `SELECT match_date, board, team, csv_data
         FROM score_csv_uploads
         WHERE ${predicates.join(' OR ')}
         ORDER BY match_date, board, team`,
        values
    );
    if (result.rows.length !== selection.length) {
        sendJson(response, 404, { error: 'One or more selected uploads could not be found.' });
        return;
    }

    const totalCsvBytes = result.rows.reduce((total, row) => total + Buffer.byteLength(row.csv_data), 0);
    if (totalCsvBytes > MAX_EXPORT_CSV_BYTES) {
        throw new RequestError(413, 'The selected uploads exceed the 10 MB export limit.');
    }
    const parsedUploads = result.rows.map(upload => {
        const rows = parseCsv(upload.csv_data).filter(row => !row.every(value => !value.trim()));
        return { header: rows[0], rows: rows.slice(1) };
    });
    const roundCount = Math.max(0, ...parsedUploads.flatMap(upload =>
        upload.header.filter(header => /^round_\d+$/.test(header))
            .map(header => Number(header.slice('round_'.length)))
    ));
    const headers = [
        'match_date', 'board', 'game', 'team', 'opponent', 'winner', 'player',
        ...Array.from({ length: roundCount }, (_, index) => `round_${index + 1}`),
        'Checkout'
    ];

    const csvRows = [headers];
    for (const upload of parsedUploads) {
        const columnIndexes = new Map(upload.header.map((header, index) => [header, index]));
        for (const row of upload.rows) {
            csvRows.push(headers.map(header => {
                const index = columnIndexes.get(header);
                const value = index === undefined ? '' : row[index] || '';
                return value;
            }));
        }
    }

    const csv = csvRows
        .map(row => row.map(serializeCsvCell).join(','))
        .join('\r\n');
    const file = Buffer.from(csv, 'utf8');
    response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': file.length,
        'Content-Disposition': 'attachment; filename="701-score-uploads.csv"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(file);
}

function serializeCsvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

async function handleUpload(request, response, url, { pool, uploadApiKey }) {
    if (!isAuthorized(request, uploadApiKey)) {
        request.resume();
        sendJson(response, 401, { error: 'A valid league upload key is required.' });
        return;
    }

    if (request.method === 'POST') {
        if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'text/csv') {
            request.resume();
            sendJson(response, 415, { error: 'Content-Type must be text/csv.' });
            return;
        }
        const csvText = await readCsvBody(request);
        const fixture = validateScoreCsv(csvText);
        const result = await pool.query(
            `INSERT INTO score_csv_uploads (match_date, board, team, opponent, csv_data, row_count)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (match_date, board, team)
             DO UPDATE SET opponent = EXCLUDED.opponent,
                           csv_data = EXCLUDED.csv_data,
                           row_count = EXCLUDED.row_count,
                           uploaded_at = CURRENT_TIMESTAMP
             RETURNING uploaded_at`,
            [fixture.matchDate, fixture.board, fixture.team, fixture.opponent, csvText, fixture.rowCount]
        );
        sendJson(response, 200, {
            saved: true,
            rowCount: fixture.rowCount,
            uploadedAt: result.rows[0].uploaded_at
        });
        return;
    }

    const matchDate = url.searchParams.get('match_date') || '';
    const board = url.searchParams.get('board') || '';
    const team = url.searchParams.get('team') || '';
    if (!matchDate || !board || !team) {
        sendJson(response, 400, { error: 'Provide match_date, board, and team to download a saved CSV.' });
        return;
    }
    const result = await pool.query(
        'SELECT csv_data FROM score_csv_uploads WHERE match_date = $1 AND board = $2 AND team = $3',
        [matchDate, board, team]
    );
    if (!result.rows.length) {
        sendJson(response, 404, { error: 'No saved CSV was found for that match and team.' });
        return;
    }
    const csv = result.rows[0].csv_data;
    response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': Buffer.byteLength(csv),
        'Content-Disposition': 'attachment; filename="701-results.csv"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(csv);
}

async function serveStatic(request, response, publicDir, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end('Method not allowed.');
        return;
    }
    const fileName = pathname === '/' ? 'index.html' : pathname === '/uploads' ? 'uploads.html' : pathname.slice(1);
    if (!PUBLIC_FILES.has(fileName)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found.');
        return;
    }
    const filePath = path.join(publicDir, fileName);
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(fileName)],
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
}

function createServer({ pool, uploadApiKey, publicDir = __dirname }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('A PostgreSQL pool is required.');
    if (!uploadApiKey) throw new Error('UPLOAD_API_KEY must be configured.');

    return http.createServer((request, response) => {
        let url;
        try {
            url = new URL(request.url, 'http://localhost');
        } catch {
            sendJson(response, 400, { error: 'Invalid request URL.' });
            return;
        }
        const pathname = decodeURIComponent(url.pathname);
        const context = { pool, uploadApiKey };
        const handler = pathname === '/api/score-uploads'
            ? handleUpload(request, response, url, context)
            : pathname === '/api/score-uploads/list'
                ? handleUploadList(request, response, context)
                : pathname === '/api/score-uploads/export'
                    ? handleUploadExport(request, response, context)
                    : pathname.startsWith('/api/')
                        ? Promise.resolve(sendJson(response, 404, { error: 'API route not found.' }))
                        : serveStatic(request, response, publicDir, pathname);
        handler.catch(error => {
            if (response.headersSent) {
                response.destroy(error);
                return;
            }
            if (error instanceof RequestError) {
                sendJson(response, error.statusCode, { error: error.message });
                return;
            }
            console.error('Request failed:', error);
            sendJson(response, 500, { error: 'The server could not process the request.' });
        });
    });
}

async function initializeDatabase(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS score_csv_uploads (
            match_date DATE NOT NULL,
            board TEXT NOT NULL,
            team TEXT NOT NULL,
            opponent TEXT NOT NULL,
            csv_data TEXT NOT NULL,
            row_count INTEGER NOT NULL,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (match_date, board, team)
        )
    `);
}

async function startServer() {
    const databaseUrl = process.env.DATABASE_URL;
    const uploadApiKey = process.env.UPLOAD_API_KEY;
    if (!databaseUrl) throw new Error('DATABASE_URL must be configured.');
    if (!uploadApiKey) throw new Error('UPLOAD_API_KEY must be configured.');

    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    await initializeDatabase(pool);

    const server = createServer({ pool, uploadApiKey });
    const port = Number(process.env.PORT) || 10000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', resolve);
    });
    console.log(`701 Club server listening on port ${port}.`);

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            server.close(() => pool.end().then(() => process.exit(0)));
        });
    }
}

if (require.main === module) {
    startServer().catch(error => {
        console.error('Could not start the 701 Club server:', error);
        process.exitCode = 1;
    });
}

module.exports = { createServer, initializeDatabase, parseCsv, validateScoreCsv };
