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
    'admin/index.html',
    'admin/admin.js',
    'admin/styles.css',
    'admin/admin-guide.html',
    'reports/index.html',
    'reports/reports.js',
    'reports/styles.css',
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

function isAdminAuthorized(request, adminApiKey) {
    return Boolean(adminApiKey) && isAuthorized(request, adminApiKey);
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

async function resolveReportSeason(pool, url) {
    const seasonId = url.searchParams.get('season_id');
    const seasonName = url.searchParams.get('season');
    if (seasonId) {
        if (!/^\d+$/.test(seasonId)) {
            throw new RequestError(400, 'season_id must be a positive integer.');
        }
        const result = await pool.query(
            'SELECT id, name FROM season WHERE id = $1',
            [Number(seasonId)]
        );
        if (!result.rows.length) throw new RequestError(404, 'Season not found.');
        return result.rows[0];
    }
    if (seasonName) {
        const result = await pool.query(
            'SELECT id, name FROM season WHERE name = $1',
            [seasonName]
        );
        if (!result.rows.length) throw new RequestError(404, 'Season not found.');
        return result.rows[0];
    }
    const result = await pool.query(
        'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
    );
    if (!result.rows.length) throw new RequestError(404, 'No active season found.');
    return result.rows[0];
}

async function handleReportStandings(request, response, url, { pool }) {
    if (request.method !== 'GET') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const season = await resolveReportSeason(pool, url);
    const result = await pool.query(
        `WITH game_results AS (
            SELECT mg.winner_team_id,
                   CASE WHEN mg.winner_team_id = f.home_team_id
                        THEN f.away_team_id
                        WHEN mg.winner_team_id = f.away_team_id
                        THEN f.home_team_id
                   END AS loser_team_id
            FROM match_game mg
            JOIN fixture f ON f.id = mg.fixture_id
            JOIN season s ON s.id = f.season_id
            JOIN game_submission gs ON gs.match_game_id = mg.id
            WHERE f.season_id = $1
              AND mg.status = 'finished'
              AND mg.winner_team_id IS NOT NULL
              AND gs.status = 'accepted'
              AND COALESCE(f.week_number, 999) > s.baseline_through_week
         ),
         team_totals AS (
            SELECT f.season_id, team_id,
                   SUM(ts.score) AS team_score,
                   COUNT(ts.id) AS team_shots
            FROM turn_score ts
            JOIN match_game mg ON mg.id = ts.match_game_id
            JOIN fixture f ON f.id = mg.fixture_id
            JOIN game_submission gs ON gs.id = ts.submission_id
            JOIN season s ON s.id = f.season_id
            WHERE f.season_id = $1
              AND gs.status = 'accepted'
              AND COALESCE(f.week_number, 999) > s.baseline_through_week
            GROUP BY f.season_id, team_id
         ),
         wins AS (
            SELECT winner_team_id AS team_id, COUNT(*) AS wins
            FROM game_results
            GROUP BY winner_team_id
         ),
         losses AS (
            SELECT loser_team_id AS team_id, COUNT(*) AS losses
            FROM game_results
            WHERE loser_team_id IS NOT NULL
            GROUP BY loser_team_id
         ),
         team_baselines AS (
            SELECT tsb.team_id,
                   tsb.baseline_wins,
                   tsb.baseline_losses,
                   tsb.baseline_shots,
                   tsb.baseline_score
            FROM team_season_baseline tsb
            WHERE tsb.season_id = $1
         )
         SELECT t.name AS team,
                COALESCE(tb.baseline_wins, 0) + COALESCE(w.wins, 0) AS wins,
                COALESCE(tb.baseline_losses, 0) + COALESCE(l.losses, 0) AS losses,
                COALESCE(tb.baseline_wins, 0) + COALESCE(w.wins, 0)
                    + COALESCE(tb.baseline_losses, 0) + COALESCE(l.losses, 0) AS games,
                CASE WHEN COALESCE(tb.baseline_shots, 0) + COALESCE(tt.team_shots, 0) > 0
                     THEN ROUND(
                        (COALESCE(tb.baseline_score, 0) + COALESCE(tt.team_score, 0))::NUMERIC
                        / (COALESCE(tb.baseline_shots, 0) + COALESCE(tt.team_shots, 0)),
                        2
                     )
                     ELSE 0
                END AS average
         FROM team t
         LEFT JOIN wins w ON w.team_id = t.id
         LEFT JOIN losses l ON l.team_id = t.id
         LEFT JOIN team_totals tt ON tt.team_id = t.id
         LEFT JOIN team_baselines tb ON tb.team_id = t.id
         WHERE t.id IN (
            SELECT home_team_id FROM fixture WHERE season_id = $1
            UNION
            SELECT away_team_id FROM fixture WHERE season_id = $1
         )
         ORDER BY 2 DESC, 3 ASC, t.name`,
        [season.id]
    );
    sendJson(response, 200, { season: season.name, standings: result.rows });
}

async function handlePlayerReport(request, response, url, gender, reportName, { pool }) {
    if (request.method !== 'GET') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const season = await resolveReportSeason(pool, url);
    const orderBy = {
        'mens-avg': 'average DESC, pt.score DESC, player',
        'mens-95': 'pt.ninetyfive_plus DESC, average DESC, player',
        'mens-outs': 'pt.outs DESC, average DESC, player',
        'lady-avg': 'average DESC, pt.score DESC, player',
        'lady-95': 'pt.ninetyfive_plus DESC, average DESC, player',
        'lady-outs': 'pt.outs DESC, average DESC, player'
    }[reportName] || 'average DESC, pt.score DESC, player';
    const reportFilter = reportName.endsWith('-95')
        ? 'AND pt.ninetyfive_plus > 0'
        : reportName.endsWith('-outs')
            ? 'AND pt.outs > 0'
            : '';
    const result = await pool.query(
        `WITH future_totals AS (
            SELECT tr.team_id,
                   ts.player_id,
                   COUNT(DISTINCT ts.match_game_id) AS gp,
                   COUNT(ts.id) AS shots,
                   SUM(ts.score) AS score,
                   COUNT(*) FILTER (WHERE ts.score >= 95) AS ninetyfive_plus,
                   COUNT(*) FILTER (WHERE ts.checkout_remaining IS NOT NULL) AS outs,
                   COUNT(*) FILTER (WHERE ts.score = 171) AS score_171,
                   COUNT(*) FILTER (WHERE ts.score = 180) AS score_180,
                   COUNT(*) FILTER (
                        WHERE ts.checkout_remaining IS NOT NULL
                          AND ts.checkout_remaining <= 50
                   ) AS fifty_plus_finishes
            FROM turn_score ts
            JOIN match_game mg ON mg.id = ts.match_game_id
            JOIN fixture f ON f.id = mg.fixture_id
            JOIN season s ON s.id = f.season_id
            JOIN team_roster tr ON tr.season_id = f.season_id
                               AND tr.team_id = ts.team_id
                               AND tr.player_id = ts.player_id
            JOIN game_submission gs ON gs.id = ts.submission_id
            WHERE f.season_id = $1
              AND gs.status = 'accepted'
              AND COALESCE(f.week_number, 999) > s.baseline_through_week
            GROUP BY tr.team_id, ts.player_id
         ),
         player_totals AS (
            SELECT tr.team_id,
                   tr.player_id,
                   COALESCE(tr.gender, p.gender) AS gender,
                   COALESCE(pb.baseline_games, 0) + COALESCE(ft.gp, 0) AS gp,
                   COALESCE(pb.baseline_shots, 0) + COALESCE(ft.shots, 0) AS shots,
                   COALESCE(pb.baseline_score, 0) + COALESCE(ft.score, 0) AS score,
                   COALESCE(pb.baseline_ninetyfive_plus, 0) + COALESCE(ft.ninetyfive_plus, 0) AS ninetyfive_plus,
                   COALESCE(pb.baseline_outs, 0) + COALESCE(ft.outs, 0) AS outs,
                   COALESCE(pb.baseline_score_171, 0) + COALESCE(ft.score_171, 0) AS score_171,
                   COALESCE(pb.baseline_score_180, 0) + COALESCE(ft.score_180, 0) AS score_180,
                   COALESCE(pb.baseline_fifty_plus_finishes, 0)
                       + COALESCE(ft.fifty_plus_finishes, 0) AS fifty_plus_finishes
            FROM team_roster tr
            JOIN player p ON p.id = tr.player_id
            LEFT JOIN player_season_baseline pb
              ON pb.season_id = tr.season_id
             AND pb.team_id = tr.team_id
             AND pb.player_id = tr.player_id
            LEFT JOIN future_totals ft
              ON ft.team_id = tr.team_id
             AND ft.player_id = tr.player_id
            WHERE tr.season_id = $1
              AND (pb.player_id IS NOT NULL OR ft.player_id IS NOT NULL)
         )
         SELECT BTRIM(p.first_name || CASE
                    WHEN COALESCE(p.last_name, '') = '' THEN ''
                    ELSE ' ' || p.last_name
                END) AS player,
                t.name AS team,
                pt.gp,
                pt.shots,
                pt.score,
                CASE WHEN pt.shots > 0
                     THEN ROUND(pt.score::NUMERIC / pt.shots, 2)
                     ELSE 0
                END AS average,
                pt.ninetyfive_plus AS "95+",
                pt.outs,
                pt.score_171 AS "171",
                pt.score_180 AS "180",
                pt.fifty_plus_finishes AS "50+Fin."
         FROM player_totals pt
         JOIN player p ON p.id = pt.player_id
         JOIN team t ON t.id = pt.team_id
         WHERE pt.gender = $2
         ${reportFilter}
         ORDER BY ${orderBy}`,
        [season.id, gender]
    ).catch(error => {
        error.message = `${error.message} (report: ${reportName})`;
        throw error;
    });
    sendJson(response, 200, {
        season: season.name,
        report: reportName,
        players: result.rows
    });
}

async function handleMensOverall(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'M', 'mens-overall', context);
}

async function handleLadyOverall(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'F', 'lady-overall', context);
}

async function handleMensAvg(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'M', 'mens-avg', context);
}

async function handleMens95(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'M', 'mens-95', context);
}

async function handleMensOuts(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'M', 'mens-outs', context);
}

async function handleLadyAvg(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'F', 'lady-avg', context);
}

async function handleLady95(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'F', 'lady-95', context);
}

async function handleLadyOuts(request, response, url, context) {
    await handlePlayerReport(request, response, url, 'F', 'lady-outs', context);
}

async function handleSeasons(request, response, { pool }) {
    if (request.method !== 'GET') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const result = await pool.query(
        `SELECT id, name, start_date, end_date, active
         FROM season
         ORDER BY active DESC,
                  COALESCE(start_date, '0001-01-01'::DATE) DESC,
                  name DESC`
    );
    sendJson(response, 200, {
        seasons: result.rows.map(row => ({
            id: row.id,
            name: row.name,
            startDate: row.start_date ? formatDatabaseDate(row.start_date) : null,
            endDate: row.end_date ? formatDatabaseDate(row.end_date) : null,
            active: row.active
        }))
    });
}

async function handleAdminSeasonMutation(request, response, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method === 'GET') {
        const result = await context.pool.query(
            `SELECT id, name, start_date, end_date, active
             FROM season
             ORDER BY active DESC, COALESCE(start_date, '0001-01-01'::DATE) DESC, name DESC`
        );
        sendJson(response, 200, {
            seasons: result.rows.map(row => ({
                id: row.id,
                name: row.name,
                startDate: row.start_date ? formatDatabaseDate(row.start_date) : null,
                endDate: row.end_date ? formatDatabaseDate(row.end_date) : null,
                active: row.active
            }))
        });
        return;
    }
    if (request.method !== 'POST') {
        throw new RequestError(405, 'Method not allowed.');
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const body = await readJsonBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new RequestError(400, 'Season name is required.');
    if (body.startDate && !isValidDate(body.startDate)) {
        throw new RequestError(400, 'startDate must use YYYY-MM-DD.');
    }
    if (body.endDate && !isValidDate(body.endDate)) {
        throw new RequestError(400, 'endDate must use YYYY-MM-DD.');
    }
    if (body.active) {
        await context.pool.query('UPDATE season SET active = FALSE');
    }
    const result = await context.pool.query(
        `INSERT INTO season (name, start_date, end_date, active)
         VALUES ($1, $2::DATE, $3::DATE, $4)
         ON CONFLICT (name) DO UPDATE SET
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            active = EXCLUDED.active
         RETURNING id, name, start_date, end_date, active`,
        [name, body.startDate || null, body.endDate || null, Boolean(body.active)]
    );
    sendJson(response, 201, { season: result.rows[0] });
}

async function handleAdminTeams(request, response, url, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method === 'GET') {
        const seasonId = url.searchParams.get('season_id');
        const values = seasonId ? [Number(seasonId)] : [];
        const seasonJoin = seasonId
            ? 'LEFT JOIN team_roster tr ON tr.team_id = t.id AND tr.season_id = $1'
            : 'LEFT JOIN team_roster tr ON tr.team_id = t.id';
        const result = await context.pool.query(
            `SELECT t.id, t.name,
                    COUNT(tr.player_id) AS roster_count
             FROM team t
             ${seasonJoin}
             GROUP BY t.id, t.name
             ORDER BY t.name`,
            values
        );
        sendJson(response, 200, { teams: result.rows });
        return;
    }
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) {
        throw new RequestError(405, 'Method not allowed.');
    }
    if (request.method === 'DELETE') {
        const idMatch = /^\/api\/admin\/teams\/(\d+)\/?$/.exec(url.pathname);
        if (!idMatch) throw new RequestError(400, 'A valid team id is required.');
        const result = await context.pool.query(
            'DELETE FROM team WHERE id = $1 RETURNING id',
            [Number(idMatch[1])]
        );
        if (!result.rows.length) throw new RequestError(404, 'Team not found.');
        sendJson(response, 200, { deleted: true });
        return;
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const body = await readJsonBody(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new RequestError(400, 'Team name is required.');

    if (request.method === 'POST') {
        const result = await context.pool.query(
            `INSERT INTO team (name)
             VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
             RETURNING id, name`,
            [name]
        );
        sendJson(response, 201, { team: result.rows[0] });
        return;
    }
    const idMatch = /^\/api\/admin\/teams\/(\d+)\/?$/.exec(url.pathname);
    if (!idMatch) throw new RequestError(400, 'A valid team id is required.');
    const result = await context.pool.query(
        `UPDATE team
         SET name = $1
         WHERE id = $2
         RETURNING id, name`,
        [name, Number(idMatch[1])]
    );
    if (!result.rows.length) throw new RequestError(404, 'Team not found.');
    sendJson(response, 200, { team: result.rows[0] });
}

async function handleAdminPlayers(request, response, url, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method === 'POST' && /^\/api\/admin\/players\/merge\/?$/.test(url.pathname)) {
        if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
            throw new RequestError(415, 'Content-Type must be application/json.');
        }
        const body = await readJsonBody(request);
        const canonicalId = Number(body.canonicalId ?? body.canonical_id);
        const duplicateId = Number(body.duplicateId ?? body.duplicate_id);
        if (!Number.isInteger(canonicalId) || !Number.isInteger(duplicateId)) {
            throw new RequestError(400, 'canonicalId and duplicateId are required.');
        }
        if (canonicalId === duplicateId) {
            throw new RequestError(400, 'Canonical and duplicate IDs must be different.');
        }
        if (typeof context.pool.connect !== 'function') {
            throw new RequestError(503, 'Player merge requires PostgreSQL.');
        }
        const client = await context.pool.connect();
        try {
            await client.query('BEGIN');
            const canonical = await client.query(
                'SELECT id FROM player WHERE id = $1',
                [canonicalId]
            );
            const duplicate = await client.query(
                'SELECT id FROM player WHERE id = $1',
                [duplicateId]
            );
            if (!canonical.rows.length || !duplicate.rows.length) {
                throw new RequestError(404, 'Canonical or duplicate player was not found.');
            }
            const { mergePlayerRecords } = require('./db/merge-player-records');
            await mergePlayerRecords(client, canonicalId, duplicateId);
            await client.query('COMMIT');
            sendJson(response, 200, {
                merged: true,
                canonicalId,
                duplicateId
            });
            return;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    if (request.method === 'DELETE') {
        const idMatch = /^\/api\/admin\/players\/(\d+)\/?$/.exec(url.pathname);
        if (!idMatch) throw new RequestError(400, 'A valid player id is required.');
        const result = await context.pool.query(
            'DELETE FROM player WHERE id = $1 RETURNING id',
            [Number(idMatch[1])]
        );
        if (!result.rows.length) throw new RequestError(404, 'Player not found.');
        sendJson(response, 200, { deleted: true });
        return;
    }
    if (request.method === 'PUT') {
        const idMatch = /^\/api\/admin\/players\/(\d+)\/?$/.exec(url.pathname);
        if (!idMatch) throw new RequestError(400, 'A valid player id is required.');
        if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
            throw new RequestError(415, 'Content-Type must be application/json.');
        }
        const body = await readJsonBody(request);
        const firstName = typeof body.firstName === 'string'
            ? body.firstName.trim()
            : typeof body.first_name === 'string'
                ? body.first_name.trim()
                : '';
        const lastName = typeof body.lastName === 'string'
            ? body.lastName.trim()
            : typeof body.last_name === 'string'
                ? body.last_name.trim()
                : '';
        const gender = typeof body.gender === 'string'
            ? body.gender.trim().toUpperCase()
            : '';
        if (!firstName) throw new RequestError(400, 'firstName is required.');
        if (!['M', 'F'].includes(gender)) {
            throw new RequestError(400, 'gender must be M or F.');
        }
        const result = await context.pool.query(
            `UPDATE player
             SET first_name = $1, last_name = $2, gender = $3
             WHERE id = $4
             RETURNING id, first_name, last_name, gender`,
            [firstName, lastName, gender, Number(idMatch[1])]
        );
        if (!result.rows.length) throw new RequestError(404, 'Player not found.');
        sendJson(response, 200, { player: result.rows[0] });
        return;
    }
    const seasonId = url.searchParams.get('season_id');
    if (request.method === 'GET') {
        if (seasonId) {
            const result = await context.pool.query(
                `SELECT p.id, p.first_name, p.last_name,
                        COALESCE(tr.gender, p.gender) AS gender,
                        t.id AS team_id, t.name AS team
                 FROM team_roster tr
                 JOIN player p ON p.id = tr.player_id
                 JOIN team t ON t.id = tr.team_id
                 WHERE tr.season_id = $1
                 ORDER BY t.name, p.first_name, p.last_name`,
                [Number(seasonId)]
            );
            sendJson(response, 200, { players: result.rows });
            return;
        }
        const result = await context.pool.query(
            `SELECT id, first_name, last_name, gender
             FROM player
             ORDER BY first_name, last_name`
        );
        sendJson(response, 200, { players: result.rows });
        return;
    }
    if (request.method !== 'POST') {
        throw new RequestError(405, 'Method not allowed.');
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const body = await readJsonBody(request);
    const firstName = typeof body.firstName === 'string' ? body.firstName.trim()
        : typeof body.first_name === 'string' ? body.first_name.trim() : '';
    const lastName = typeof body.lastName === 'string' ? body.lastName.trim()
        : typeof body.last_name === 'string' ? body.last_name.trim() : '';
    const gender = typeof body.gender === 'string' ? body.gender.trim().toUpperCase() : '';
    if (!firstName) throw new RequestError(400, 'firstName is required.');
    if (!['M', 'F'].includes(gender)) throw new RequestError(400, 'gender must be M or F.');

    const playerResult = await context.pool.query(
        `INSERT INTO player (first_name, last_name, gender)
         VALUES ($1, $2, $3)
         ON CONFLICT (first_name, last_name) DO UPDATE SET gender = EXCLUDED.gender
         RETURNING id, first_name, last_name, gender`,
        [firstName, lastName, gender]
    );
    const player = playerResult.rows[0];
    if (body.teamId || body.team_id) {
        if (!body.seasonId && !body.season_id) {
            throw new RequestError(400, 'seasonId is required when teamId is provided.');
        }
        await context.pool.query(
            `INSERT INTO team_roster (season_id, team_id, player_id, gender)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (season_id, team_id, player_id)
             DO UPDATE SET gender = EXCLUDED.gender`,
            [
                Number(body.seasonId ?? body.season_id),
                Number(body.teamId ?? body.team_id),
                player.id,
                gender
            ]
        );
    }
    sendJson(response, 201, { player });
}

async function handleAdminFixtures(request, response, url, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method === 'GET') {
        const seasonId = url.searchParams.get('season_id');
        const values = seasonId ? [Number(seasonId)] : [];
        const where = seasonId ? 'WHERE f.season_id = $1' : '';
        const result = await context.pool.query(
            `SELECT f.id, f.season_id, f.week_number, f.match_date,
                    f.board_number, f.home_team_id, f.away_team_id,
                    ht.name AS home_team, at.name AS away_team
             FROM fixture f
             JOIN team ht ON ht.id = f.home_team_id
             JOIN team at ON at.id = f.away_team_id
             ${where}
             ORDER BY f.match_date, f.board_number, f.id`,
            values
        );
        sendJson(response, 200, {
            fixtures: result.rows.map(row => ({
                ...row,
                match_date: formatDatabaseDate(row.match_date)
            }))
        });
        return;
    }
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) {
        throw new RequestError(405, 'Method not allowed.');
    }
    if (request.method === 'DELETE') {
        const idMatch = /^\/api\/admin\/fixtures\/(\d+)\/?$/.exec(url.pathname);
        if (!idMatch) throw new RequestError(400, 'A valid fixture id is required.');
        const result = await context.pool.query(
            'DELETE FROM fixture WHERE id = $1 RETURNING id',
            [Number(idMatch[1])]
        );
        if (!result.rows.length) throw new RequestError(404, 'Fixture not found.');
        sendJson(response, 200, { deleted: true });
        return;
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const body = await readJsonBody(request);
    const seasonId = Number(body.seasonId ?? body.season_id);
    const homeTeamId = Number(body.homeTeamId ?? body.home_team_id ?? body.team1Id);
    const awayTeamId = Number(body.awayTeamId ?? body.away_team_id ?? body.team2Id);
    const matchDate = body.matchDate ?? body.match_date;
    const boardNumber = body.boardNumber ?? body.board_number ?? body.board ?? null;
    const weekNumber = body.weekNumber ?? body.week_number ?? null;
    if (!Number.isInteger(seasonId) || !Number.isInteger(homeTeamId) ||
        !Number.isInteger(awayTeamId) || !isValidDate(matchDate)) {
        throw new RequestError(400, 'seasonId, teams, and matchDate are required.');
    }
    if (homeTeamId === awayTeamId) {
        throw new RequestError(400, 'Home and away teams must be different.');
    }
    if (weekNumber !== null && (!Number.isInteger(Number(weekNumber)) || Number(weekNumber) < 1)) {
        throw new RequestError(400, 'weekNumber must be a positive integer.');
    }

    if (request.method === 'POST') {
        const result = await context.pool.query(
            `INSERT INTO fixture (
                season_id, week_number, match_date, board_number,
                home_team_id, away_team_id
             )
             VALUES ($1, $2, $3::DATE, $4, $5, $6)
             RETURNING id, season_id, week_number, match_date,
                       board_number, home_team_id, away_team_id`,
            [seasonId, weekNumber === null ? null : Number(weekNumber),
             matchDate, boardNumber, homeTeamId, awayTeamId]
        );
        sendJson(response, 201, { fixture: result.rows[0] });
        return;
    }
    const idMatch = /^\/api\/admin\/fixtures\/(\d+)\/?$/.exec(url.pathname);
    if (!idMatch) throw new RequestError(400, 'A valid fixture id is required.');
    const result = await context.pool.query(
        `UPDATE fixture
         SET season_id = $1, week_number = $2, match_date = $3::DATE,
             board_number = $4, home_team_id = $5, away_team_id = $6,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $7
         RETURNING id, season_id, week_number, match_date,
                   board_number, home_team_id, away_team_id`,
        [seasonId, weekNumber === null ? null : Number(weekNumber),
         matchDate, boardNumber, homeTeamId, awayTeamId, Number(idMatch[1])]
    );
    if (!result.rows.length) throw new RequestError(404, 'Fixture not found.');
    sendJson(response, 200, { fixture: result.rows[0] });
}

async function handleAdminSubmissions(request, response, url, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method === 'GET') {
        const seasonId = url.searchParams.get('season_id');
        const values = seasonId ? [Number(seasonId)] : [];
        const where = seasonId ? 'WHERE f.season_id = $1' : '';
        const result = await context.pool.query(
            `SELECT gs.id, gs.source, gs.source_key, gs.status,
                    gs.submitted_at, gs.accepted_at,
                    f.id AS fixture_id, f.match_date, f.board_number,
                    ht.name AS home_team, at.name AS away_team,
                    COUNT(ts.id) AS turn_count
             FROM game_submission gs
             LEFT JOIN fixture f ON f.id = gs.fixture_id
             LEFT JOIN team ht ON ht.id = f.home_team_id
             LEFT JOIN team at ON at.id = f.away_team_id
             LEFT JOIN turn_score ts ON ts.submission_id = gs.id
             ${where}
             GROUP BY gs.id, f.id, ht.name, at.name
             ORDER BY gs.submitted_at DESC`,
            values
        );
        sendJson(response, 200, { submissions: result.rows });
        return;
    }
    if (request.method !== 'POST') {
        throw new RequestError(405, 'Method not allowed.');
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const body = await readJsonBody(request);
    if (body.submissionId ?? body.submission_id) {
        const submissionId = Number(body.submissionId ?? body.submission_id);
        const status = typeof body.status === 'string'
            ? body.status.trim().toLowerCase()
            : '';
        if (!Number.isInteger(submissionId) ||
            !['accepted', 'rejected', 'superseded'].includes(status)) {
            throw new RequestError(400, 'submissionId and a valid status are required.');
        }
        const result = await context.pool.query(
            `UPDATE game_submission
             SET status = $1,
                 accepted_at = CASE WHEN $1 = 'accepted'
                                    THEN COALESCE(accepted_at, CURRENT_TIMESTAMP)
                                    ELSE accepted_at
                               END
             WHERE id = $2
             RETURNING id, status, accepted_at`,
            [status, submissionId]
        );
        if (!result.rows.length) {
            throw new RequestError(404, 'Submission not found.');
        }
        sendJson(response, 200, { submission: result.rows[0] });
        return;
    }
    const turnId = Number(body.turnId ?? body.turn_id);
    const score = Number(body.score);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!Number.isInteger(turnId) || !Number.isInteger(score) ||
        score < 0 || score > 180) {
        throw new RequestError(400, 'turnId and a valid score are required.');
    }
    if (!reason) throw new RequestError(400, 'A revision reason is required.');

    if (typeof context.pool.connect === 'function') {
        const client = await context.pool.connect();
        try {
            await client.query('BEGIN');
            const before = await client.query(
                'SELECT id, score, is_bust, checkout_remaining FROM turn_score WHERE id = $1',
                [turnId]
            );
            if (!before.rows.length) throw new RequestError(404, 'Turn not found.');
            const fixtureWeek = await client.query(
                `SELECT f.week_number,
                        s.baseline_through_week
                 FROM turn_score ts
                 JOIN game_submission gs ON gs.id = ts.submission_id
                 JOIN match_game mg ON mg.id = gs.match_game_id
                 JOIN fixture f ON f.id = mg.fixture_id
                 JOIN season s ON s.id = f.season_id
                 WHERE ts.id = $1`,
                [turnId]
            );
            if (fixtureWeek.rows.length &&
                Number(fixtureWeek.rows[0].week_number) <=
                    Number(fixtureWeek.rows[0].baseline_through_week)) {
                throw new RequestError(
                    400,
                    'Weeks through the workbook baseline cannot be revised.'
                );
            }
            const isBust = body.isBust ?? body.is_bust ?? before.rows[0].is_bust;
            const checkout = body.checkoutRemaining ?? body.checkout_remaining ??
                before.rows[0].checkout_remaining;
            await client.query(
                `INSERT INTO score_revision (
                    target_type, target_id, before_json, after_json, reason, actor
                 )
                 VALUES ('turn_score', $1, $2::JSONB, $3::JSONB, $4, 'admin')`,
                [
                    turnId,
                    JSON.stringify(before.rows[0]),
                    JSON.stringify({
                        id: turnId,
                        score,
                        is_bust: Boolean(isBust),
                        checkout_remaining: checkout === null || checkout === ''
                            ? null
                            : Number(checkout)
                    }),
                    reason
                ]
            );
            const updated = await client.query(
                `UPDATE turn_score
                 SET score = $1, is_bust = $2,
                     checkout_remaining = $3
                 WHERE id = $4
                 RETURNING id, score, is_bust, checkout_remaining`,
                [score, Boolean(isBust),
                 checkout === null || checkout === '' ? null : Number(checkout),
                 turnId]
            );
            await client.query('COMMIT');
            sendJson(response, 200, { turn: updated.rows[0], reason });
            return;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    throw new RequestError(503, 'Transactional score revisions require PostgreSQL.');
}

async function handleAdminSubmissionDetail(request, response, url, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method !== 'GET') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const idMatch = /^\/api\/admin\/submissions\/(\d+)\/?$/.exec(url.pathname);
    if (!idMatch) throw new RequestError(400, 'A valid submission id is required.');
    const submissionResult = await context.pool.query(
        `SELECT gs.id, gs.source, gs.source_key, gs.status,
                gs.raw_payload, gs.submitted_at, gs.accepted_at,
                f.id AS fixture_id, f.match_date, f.board_number,
                ht.name AS home_team, at.name AS away_team
         FROM game_submission gs
         LEFT JOIN fixture f ON f.id = gs.fixture_id
         LEFT JOIN team ht ON ht.id = f.home_team_id
         LEFT JOIN team at ON at.id = f.away_team_id
         WHERE gs.id = $1`,
        [Number(idMatch[1])]
    );
    if (!submissionResult.rows.length) {
        throw new RequestError(404, 'Submission not found.');
    }
    const turns = await context.pool.query(
        `SELECT ts.id, ts.turn_number, ts.score, ts.is_bust,
                ts.remaining_before, ts.remaining_after,
                ts.checkout_remaining,
                p.first_name || CASE
                    WHEN COALESCE(p.last_name, '') = '' THEN ''
                    ELSE ' ' || p.last_name
                END AS player,
                t.name AS team
         FROM turn_score ts
         JOIN player p ON p.id = ts.player_id
         JOIN team t ON t.id = ts.team_id
         WHERE ts.submission_id = $1
         ORDER BY ts.turn_number, player`,
        [Number(idMatch[1])]
    );
    sendJson(response, 200, {
        submission: submissionResult.rows[0],
        turns: turns.rows
    });
}

async function handleAdminRosterDelete(request, response, url, context) {
    if (!isAdminAuthorized(request, context.adminApiKey)) {
        throw new RequestError(401, 'A valid admin key is required.');
    }
    if (request.method !== 'DELETE') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const match = /^\/api\/admin\/roster\/(\d+)\/(\d+)\/(\d+)\/?$/.exec(url.pathname);
    if (!match) throw new RequestError(400, 'seasonId, teamId, and playerId are required.');
    const result = await context.pool.query(
        `DELETE FROM team_roster
         WHERE season_id = $1 AND team_id = $2 AND player_id = $3
         RETURNING player_id`,
        [Number(match[1]), Number(match[2]), Number(match[3])]
    );
    if (!result.rows.length) throw new RequestError(404, 'Roster entry not found.');
    sendJson(response, 200, { deleted: true });
}

async function handleLeaders(request, response, url, context) {
    if (request.method !== 'GET') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const season = await resolveReportSeason(context.pool, url);
    const mens = await context.pool.query(
        `WITH future_totals AS (
            SELECT tr.team_id, ts.player_id,
                   COUNT(ts.id) AS shots,
                   SUM(ts.score) AS score,
                   COUNT(*) FILTER (WHERE ts.score >= 95) AS ninetyfive_plus,
                   COUNT(*) FILTER (WHERE ts.checkout_remaining IS NOT NULL) AS outs
            FROM turn_score ts
            JOIN match_game mg ON mg.id = ts.match_game_id
            JOIN fixture f ON f.id = mg.fixture_id
            JOIN season s ON s.id = f.season_id
            JOIN team_roster tr ON tr.season_id = f.season_id
                               AND tr.team_id = ts.team_id
                               AND tr.player_id = ts.player_id
            JOIN player p ON p.id = ts.player_id
            JOIN game_submission gs ON gs.id = ts.submission_id
            WHERE f.season_id = $1
              AND gs.status = 'accepted'
              AND COALESCE(tr.gender, p.gender) = 'M'
              AND COALESCE(f.week_number, 999) > s.baseline_through_week
            GROUP BY tr.team_id, ts.player_id
         ),
         player_totals AS (
            SELECT tr.team_id,
                   tr.player_id,
                   COALESCE(pb.baseline_shots, 0) + COALESCE(ft.shots, 0) AS shots,
                   COALESCE(pb.baseline_score, 0) + COALESCE(ft.score, 0) AS score,
                   COALESCE(pb.baseline_ninetyfive_plus, 0) + COALESCE(ft.ninetyfive_plus, 0) AS ninetyfive_plus,
                   COALESCE(pb.baseline_outs, 0) + COALESCE(ft.outs, 0) AS outs
            FROM team_roster tr
            JOIN player p ON p.id = tr.player_id
            LEFT JOIN player_season_baseline pb
              ON pb.season_id = tr.season_id
             AND pb.team_id = tr.team_id
             AND pb.player_id = tr.player_id
            LEFT JOIN future_totals ft
              ON ft.team_id = tr.team_id
             AND ft.player_id = tr.player_id
            WHERE tr.season_id = $1
              AND COALESCE(tr.gender, p.gender) = 'M'
              AND (pb.player_id IS NOT NULL OR ft.player_id IS NOT NULL)
         )
         SELECT BTRIM(p.first_name || CASE
                    WHEN COALESCE(p.last_name, '') = '' THEN ''
                    ELSE ' ' || p.last_name
                END) AS player,
                t.name AS team,
                ROUND(pt.score::NUMERIC / NULLIF(pt.shots, 0), 2) AS average,
                pt.ninetyfive_plus AS "95+",
                pt.outs
         FROM player_totals pt
         JOIN player p ON p.id = pt.player_id
         JOIN team t ON t.id = pt.team_id
         WHERE pt.shots > 0
         ORDER BY average DESC, pt.score DESC`,
        [season.id]
    );
    const ladies = await context.pool.query(
        `WITH future_totals AS (
            SELECT tr.team_id, ts.player_id,
                   COUNT(ts.id) AS shots,
                   SUM(ts.score) AS score,
                   COUNT(*) FILTER (WHERE ts.score >= 95) AS ninetyfive_plus,
                   COUNT(*) FILTER (WHERE ts.checkout_remaining IS NOT NULL) AS outs
            FROM turn_score ts
            JOIN match_game mg ON mg.id = ts.match_game_id
            JOIN fixture f ON f.id = mg.fixture_id
            JOIN season s ON s.id = f.season_id
            JOIN team_roster tr ON tr.season_id = f.season_id
                               AND tr.team_id = ts.team_id
                               AND tr.player_id = ts.player_id
            JOIN player p ON p.id = ts.player_id
            JOIN game_submission gs ON gs.id = ts.submission_id
            WHERE f.season_id = $1
              AND gs.status = 'accepted'
              AND COALESCE(tr.gender, p.gender) = 'F'
              AND COALESCE(f.week_number, 999) > s.baseline_through_week
            GROUP BY tr.team_id, ts.player_id
         ),
         player_totals AS (
            SELECT tr.team_id,
                   tr.player_id,
                   COALESCE(pb.baseline_shots, 0) + COALESCE(ft.shots, 0) AS shots,
                   COALESCE(pb.baseline_score, 0) + COALESCE(ft.score, 0) AS score,
                   COALESCE(pb.baseline_ninetyfive_plus, 0) + COALESCE(ft.ninetyfive_plus, 0) AS ninetyfive_plus,
                   COALESCE(pb.baseline_outs, 0) + COALESCE(ft.outs, 0) AS outs
            FROM team_roster tr
            JOIN player p ON p.id = tr.player_id
            LEFT JOIN player_season_baseline pb
              ON pb.season_id = tr.season_id
             AND pb.team_id = tr.team_id
             AND pb.player_id = tr.player_id
            LEFT JOIN future_totals ft
              ON ft.team_id = tr.team_id
             AND ft.player_id = tr.player_id
            WHERE tr.season_id = $1
              AND COALESCE(tr.gender, p.gender) = 'F'
              AND (pb.player_id IS NOT NULL OR ft.player_id IS NOT NULL)
         )
         SELECT BTRIM(p.first_name || CASE
                    WHEN COALESCE(p.last_name, '') = '' THEN ''
                    ELSE ' ' || p.last_name
                END) AS player,
                t.name AS team,
                ROUND(pt.score::NUMERIC / NULLIF(pt.shots, 0), 2) AS average,
                pt.ninetyfive_plus AS "95+",
                pt.outs
         FROM player_totals pt
         JOIN player p ON p.id = pt.player_id
         JOIN team t ON t.id = pt.team_id
         WHERE pt.shots > 0
         ORDER BY average DESC, pt.score DESC`,
        [season.id]
    );
    sendJson(response, 200, {
        season: season.name,
        mens: mens.rows,
        ladies: ladies.rows
    });
}

async function handleMatchReport(request, response, url, { pool }) {
    if (request.method !== 'GET') {
        throw new RequestError(405, 'Method not allowed.');
    }
    const matchId = /^\/api\/reports\/match\/(\d+)\/?$/.exec(url.pathname);
    if (!matchId) throw new RequestError(400, 'A valid match id is required.');

    const fixtureResult = await pool.query(
        `SELECT f.id, f.season_id, f.week_number, f.match_date, f.board_number,
                ht.name AS home_team, at.name AS away_team, s.name AS season
         FROM fixture f
         JOIN team ht ON ht.id = f.home_team_id
         JOIN team at ON at.id = f.away_team_id
         JOIN season s ON s.id = f.season_id
         WHERE f.id = $1`,
        [Number(matchId[1])]
    );
    if (!fixtureResult.rows.length) {
        throw new RequestError(404, 'Match not found.');
    }
    const fixture = fixtureResult.rows[0];
    const games = await pool.query(
        `SELECT mg.id, mg.game_number, mg.status,
                wt.name AS winner_team,
                BTRIM(fp.first_name || CASE
                    WHEN COALESCE(fp.last_name, '') = '' THEN ''
                    ELSE ' ' || fp.last_name
                END) AS finishing_player,
                mg.finish_remaining
         FROM match_game mg
         LEFT JOIN team wt ON wt.id = mg.winner_team_id
         LEFT JOIN player fp ON fp.id = mg.finishing_player_id
         JOIN game_submission gs ON gs.match_game_id = mg.id
         WHERE mg.fixture_id = $1
           AND gs.status = 'accepted'
         ORDER BY mg.game_number`,
        [fixture.id]
    );
    const scores = await pool.query(
        `SELECT ts.match_game_id, mg.game_number,
                BTRIM(p.first_name || CASE
                    WHEN COALESCE(p.last_name, '') = '' THEN ''
                    ELSE ' ' || p.last_name
                END) AS player,
                t.name AS team,
                ts.turn_number, ts.score, ts.is_bust,
                ts.remaining_before, ts.remaining_after,
                ts.checkout_remaining
         FROM turn_score ts
         JOIN match_game mg ON mg.id = ts.match_game_id
         JOIN player p ON p.id = ts.player_id
         JOIN team t ON t.id = ts.team_id
         JOIN game_submission gs ON gs.id = ts.submission_id
         WHERE mg.fixture_id = $1
           AND gs.status = 'accepted'
         ORDER BY mg.game_number, t.name, ts.turn_number`,
        [fixture.id]
    );
    sendJson(response, 200, {
        match: fixture,
        games: games.rows,
        scores: scores.rows
    });
}

function formatBrowserSubmissionCsv(payload) {
    const roundCount = Math.max(0, ...payload.games.flatMap(game =>
        game.players.flatMap(player => {
            const playerTurns = game.turns.filter(turn =>
                String(turn.player).trim() === String(player.name).trim()
            );
            return [playerTurns.length];
        })
    ));
    const headers = [
        'match_date', 'board', 'game', 'team', 'opponent', 'winner', 'player',
        ...Array.from({ length: roundCount }, (_, index) => `round_${index + 1}`),
        'Checkout'
    ];
    const rows = [headers];
    for (const game of payload.games) {
        for (const player of game.players) {
            const playerTurns = game.turns.filter(turn =>
                String(turn.player).trim() === String(player.name).trim()
            );
            const roundScores = Array.from({ length: roundCount }, (_, index) =>
                playerTurns[index] ? String(playerTurns[index].score) : ''
            );
            const checkoutTurn = playerTurns.find(turn =>
                turn.remainingAfter === 0 && !turn.busted
            );
            rows.push([
                payload.matchDate,
                payload.board,
                String(game.game),
                payload.team,
                payload.opponent,
                game.winner,
                player.name,
                ...roundScores,
                checkoutTurn ? String(checkoutTurn.score) : ''
            ]);
        }
    }
    return rows
        .map(row => row.map(serializeCsvCell).join(','))
        .join('\r\n');
}

async function handleBrowserSubmission(request, response, context) {
    if (!isAuthorized(request, context.uploadApiKey)) {
        request.resume();
        sendJson(response, 401, { error: 'A valid league upload key is required.' });
        return;
    }
    if (request.method !== 'POST') {
        request.resume();
        throw new RequestError(405, 'Method not allowed.');
    }
    if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        request.resume();
        throw new RequestError(415, 'Content-Type must be application/json.');
    }
    const payload = await readJsonBody(request);
    let csvText;
    try {
        csvText = formatBrowserSubmissionCsv(payload);
    } catch (error) {
        throw new RequestError(400, error.message);
    }

    const csvRowCount = payload.games.reduce(
        (total, game) => total + game.players.length,
        0
    );
    const {
        normalizeBrowserSubmission,
        validateBrowserSubmission
    } = require('./db/import-browser-submission');
    try {
        validateBrowserSubmission(payload);
    } catch (error) {
        throw new RequestError(400, error.message);
    }
    let result;
    try {
        result = await normalizeBrowserSubmission(
            context.pool,
            payload,
            csvText,
            csvRowCount
        );
    } catch (error) {
        if (error instanceof RequestError) throw error;
        if (/unknown winner|conflicts with|more than once|outside the lineup|invalid|preserved from the workbook/i.test(error.message)) {
            throw new RequestError(400, error.message);
        }
        throw error;
    }
    sendJson(response, 200, {
        saved: true,
        rowCount: result.rowCount,
        gameCount: result.gameCount,
        uploadedAt: result.uploadedAt
    });
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
        const { importScoreCsvUpload } = require('./db/import-score-csv');
        let normalized;
        try {
            normalized = await importScoreCsvUpload(pool, csvText, fixture, parseCsv);
        } catch (error) {
            if (error.code === 'LEAGUE_IMPORT_CONFLICT') {
                throw new RequestError(409, error.message);
            }
            throw error;
        }
        let uploadedAt;
        if (normalized) {
            uploadedAt = normalized.uploadedAt;
        } else {
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
            uploadedAt = result.rows[0].uploaded_at;
        }
        sendJson(response, 200, {
            saved: true,
            rowCount: fixture.rowCount,
            uploadedAt
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
    const fileName = pathname === '/'
        ? 'index.html'
        : pathname === '/uploads'
            ? 'uploads.html'
            : pathname === '/reports'
                ? 'reports/index.html'
                : pathname === '/admin'
                    ? 'admin/index.html'
                : pathname.slice(1);
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

function createServer({ pool, uploadApiKey, adminApiKey = process.env.ADMIN_API_KEY || null, publicDir = __dirname }) {
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
        const context = { pool, uploadApiKey, adminApiKey };
        let handler;
        if (pathname === '/api/score-submissions') {
            handler = handleBrowserSubmission(request, response, context);
        } else if (pathname === '/api/score-uploads') {
            handler = handleUpload(request, response, url, context);
        } else if (pathname === '/api/score-uploads/list') {
            handler = handleUploadList(request, response, context);
        } else if (pathname === '/api/score-uploads/export') {
            handler = handleUploadExport(request, response, context);
        } else if (pathname === '/api/seasons') {
            handler = handleSeasons(request, response, context);
        } else if (pathname === '/api/admin/seasons') {
            handler = handleAdminSeasonMutation(request, response, context);
        } else if (pathname === '/api/admin/teams' ||
                   /^\/api\/admin\/teams\/\d+\/?$/.test(pathname)) {
            handler = handleAdminTeams(request, response, url, context);
        } else if (pathname === '/api/admin/players' ||
                   pathname === '/api/admin/players/merge' ||
                   /^\/api\/admin\/players\/\d+\/?$/.test(pathname)) {
            handler = handleAdminPlayers(request, response, url, context);
        } else if (pathname === '/api/admin/fixtures' ||
                   /^\/api\/admin\/fixtures\/\d+\/?$/.test(pathname)) {
            handler = handleAdminFixtures(request, response, url, context);
        } else if (pathname === '/api/admin/submissions') {
            handler = handleAdminSubmissions(request, response, url, context);
        } else if (/^\/api\/admin\/submissions\/\d+\/?$/.test(pathname)) {
            handler = handleAdminSubmissionDetail(request, response, url, context);
        } else if (/^\/api\/admin\/roster\/\d+\/\d+\/\d+\/?$/.test(pathname)) {
            handler = handleAdminRosterDelete(request, response, url, context);
        } else if (pathname === '/api/reports/standings') {
            handler = handleReportStandings(request, response, url, context);
        } else if (pathname === '/api/reports/mens-overall') {
            handler = handleMensOverall(request, response, url, context);
        } else if (pathname === '/api/reports/mens-avg') {
            handler = handleMensAvg(request, response, url, context);
        } else if (pathname === '/api/reports/mens-95') {
            handler = handleMens95(request, response, url, context);
        } else if (pathname === '/api/reports/mens-outs') {
            handler = handleMensOuts(request, response, url, context);
        } else if (pathname === '/api/reports/lady-overall') {
            handler = handleLadyOverall(request, response, url, context);
        } else if (pathname === '/api/reports/lady-avg') {
            handler = handleLadyAvg(request, response, url, context);
        } else if (pathname === '/api/reports/lady-95') {
            handler = handleLady95(request, response, url, context);
        } else if (pathname === '/api/reports/lady-outs') {
            handler = handleLadyOuts(request, response, url, context);
        } else if (pathname === '/api/reports/leaders') {
            handler = handleLeaders(request, response, url, context);
        } else if (/^\/api\/reports\/match\/\d+\/?$/.test(pathname)) {
            handler = handleMatchReport(request, response, url, context);
        } else if (pathname.startsWith('/api/')) {
            handler = Promise.resolve(sendJson(response, 404, { error: 'API route not found.' }));
        } else {
            handler = serveStatic(request, response, publicDir, pathname);
        }
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
    const { runMigrations } = require('./db/migrate');
    return runMigrations(pool);
}

async function startServer() {
    const databaseUrl = process.env.DATABASE_URL;
    const uploadApiKey = process.env.UPLOAD_API_KEY;
    const adminApiKey = process.env.ADMIN_API_KEY || null;
    if (!databaseUrl) throw new Error('DATABASE_URL must be configured.');
    if (!uploadApiKey) throw new Error('UPLOAD_API_KEY must be configured.');

    const { createPool } = require('./db/connection');
    const pool = createPool(databaseUrl);
    
    // Add a test connection before proceeding
    try {
        await pool.query('SELECT 1');
        console.log('Database connection successful');
    } catch (dbError) {
        console.error('Database connection failed:', dbError.message);
        throw new Error(`Could not connect to database: ${dbError.message}`);
    }
    
    await initializeDatabase(pool);

    const server = createServer({ pool, uploadApiKey, adminApiKey });
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
