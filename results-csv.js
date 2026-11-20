'use strict';

function formatMatchResultsCSV(matchResults) {
    const roundCount = Math.max(0, ...matchResults.flatMap(game =>
        game.players.map(player => (player.roundScores || []).length)
    ));
    const rows = [[
        'match_date', 'board', 'game', 'team', 'opponent', 'winner', 'player',
        ...Array.from({ length: roundCount }, (_, index) => `round_${index + 1}`),
        'Checkout'
    ]];
    for (const game of matchResults) {
        for (const player of game.players) {
            const roundScores = player.roundScores || [];
            const roundColumns = Array.from({ length: roundCount }, (_, index) => roundScores[index] ?? '');
            rows.push([
                game.date, game.board, game.game, game.team, game.opponent, game.winner, player.name,
                ...roundColumns, player.checkout
            ]);
        }
    }
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = formatMatchResultsCSV;
}
