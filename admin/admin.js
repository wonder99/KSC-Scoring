'use strict';

let adminKey = '';
let seasons = [];
let teams = [];

const authCard = document.getElementById('auth-card');
const adminApp = document.getElementById('admin-app');
const authStatus = document.getElementById('auth-status');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatShortDate(value) {
    if (!value) return 'Unknown date';
    const text = String(value);
    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : 'Unknown date';
}

function getLocalDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function recalculateSubmissionGame(game) {
    const remainingCells = [...game.querySelectorAll('.countdown-cell[data-turn-id]')];
    const scoreCells = [...game.querySelectorAll('.review-turn-cell[data-turn-id]')]
        .sort((left, right) =>
            (left.dataset.playOrder === '' ? Number.MAX_SAFE_INTEGER : Number(left.dataset.playOrder)) -
            (right.dataset.playOrder === '' ? Number.MAX_SAFE_INTEGER : Number(right.dataset.playOrder)) ||
            Number(left.dataset.turnId) - Number(right.dataset.turnId)
        );
    let remaining = 701;
    const results = [];
    for (const cell of scoreCells) {
        const input = cell.querySelector('[name="score"]');
        const text = input.value.trim();
        let score = Number(text);
        if (!/^\d+$/.test(text) ||
            !Number.isInteger(score) ||
            score < 0 ||
            score > 180) {
            score = Number(cell.dataset.originalScore);
        }
        const isBust = cell.dataset.originalBust === '1';
        const remainingAfter = isBust
            ? remaining
            : Math.max(0, remaining - score);
        const countdownCell = remainingCells.find(item =>
            item.dataset.turnId === cell.dataset.turnId
        );
        if (countdownCell) {
            countdownCell.querySelector('strong').textContent = String(remainingAfter);
        }
        results.push({
            player: cell.dataset.player,
            team: cell.dataset.team,
            score,
            isBust,
            remainingAfter
        });
        remaining = remainingAfter;
    }
    const outcome = game.querySelector('.review-game-outcome');
    if (!outcome) return;
    const winnerTeam = game.dataset.winnerTeam || '';
    const checkout = results.find(turn => turn.remainingAfter === 0 && !turn.isBust);
    const loserTeam = winnerTeam
        ? results.find(turn => turn.team && turn.team !== winnerTeam)?.team
        : null;
    const winText = checkout
        ? `${checkout.player} won with a ${checkout.score} checkout.`
        : winnerTeam
            ? `${winnerTeam} won.`
            : null;
    const lossText = loserTeam ? `${loserTeam} lost.` : null;
    if (winText || lossText) {
        outcome.innerHTML =
            `${winText ? `<span class="review-game-win">${escapeHtml(winText)}</span>` : ''}` +
            `${lossText ? `<span class="review-game-loss">${escapeHtml(lossText)}</span>` : ''}`;
    } else {
        outcome.innerHTML = '<span>Game result unavailable.</span>';
    }
}

function resetForm(formOrId) {
    const form = typeof formOrId === 'string'
        ? document.getElementById(formOrId)
        : formOrId;
    if (form && typeof form.reset === 'function') {
        form.reset();
    }
}

async function adminFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: 'application/json',
            ...(adminKey ? { Authorization: `Bearer ${adminKey}` } : {}),
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Admin request failed.');
    return payload;
}

function getSelectedSeasonId() {
    const fixtureSeason = document.getElementById('fixture-season');
    if (fixtureSeason && fixtureSeason.value) return fixtureSeason.value;
    const playerSeason = document.getElementById('player-season');
    return playerSeason ? playerSeason.value : '';
}

async function loadSeasons() {
    const payload = await adminFetch('/api/admin/seasons');
    seasons = payload.seasons;
    document.getElementById('season-list').innerHTML = seasons.map(season => `
        <article class="data-card">
            <strong>${escapeHtml(season.name)}</strong>
            <span>${escapeHtml(season.startDate || 'No start')}</span>
            <span>${season.active ? 'Active' : 'Inactive'}</span>
            <span>${escapeHtml(season.endDate || 'Ongoing')}</span>
        </article>`).join('');
    const options = seasons.map(season =>
        `<option value="${season.id}">${escapeHtml(season.name)}</option>`
    ).join('');
    document.getElementById('player-season').innerHTML = options;
    document.getElementById('fixture-season').innerHTML = options;
    const active = seasons.find(season => season.active);
    if (active) {
        document.getElementById('player-season').value = active.id;
        document.getElementById('fixture-season').value = active.id;
    }
}

async function loadTeams() {
    const seasonId = getSelectedSeasonId();
    const payload = await adminFetch(
        `/api/admin/teams${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`
    );
    teams = payload.teams;
    if (!teams.length) {
        document.getElementById('team-list').innerHTML =
            '<p class="empty">No teams found for the selected season.</p>';
    } else {
    document.getElementById('team-list').innerHTML = teams.map(team => `
        <article class="data-card team-card">
            <strong>${escapeHtml(team.name)}</strong>
            <span>Players: ${escapeHtml(team.roster_count)}</span>
            <button type="button" data-delete-team="${team.id}">Delete</button>
        </article>`).join('');
    }
    const options = teams.map(team =>
        `<option value="${team.id}">${escapeHtml(team.name)}</option>`
    ).join('');
    document.getElementById('player-team').innerHTML = options;
    document.getElementById('fixture-home').innerHTML = options;
    document.getElementById('fixture-away').innerHTML = options;
}

async function loadPlayers() {
    const seasonId = getSelectedSeasonId();
    if (!seasonId) {
        document.getElementById('player-list').innerHTML = '';
        return;
    }
    const payload = await adminFetch(`/api/admin/players?season_id=${encodeURIComponent(seasonId)}`);
    if (!payload.players.length) {
        document.getElementById('player-list').innerHTML =
            '<p class="empty">No players found for the selected season.</p>';
        return;
    }
    document.getElementById('player-list').innerHTML = payload.players.map(player => `
        <article class="data-card player-card">
            <strong class="player-team">${escapeHtml(player.team)}</strong>
            <span class="player-name">${escapeHtml([player.first_name, player.last_name].filter(Boolean).join(' '))}</span>
            <span class="player-gender">${escapeHtml(player.gender)}</span>
            <div class="player-actions">
                <button type="button" data-edit-player="${player.id}">Edit</button>
                <button type="button" data-merge-player="${player.id}">Merge</button>
                <button type="button" data-remove-player="${seasonId}:${player.team_id}:${player.id}" title="Remove from this season roster">Remove from roster</button>
                <button type="button" data-delete-player="${player.id}" class="danger-button" title="Delete the player record and linked roster data">Delete player</button>
            </div>
        </article>`).join('');
}

async function loadFixtures() {
    const seasonId = getSelectedSeasonId();
    if (!seasonId) {
        document.getElementById('fixture-list').innerHTML = '';
        return;
    }
    const payload = await adminFetch(`/api/admin/fixtures?season_id=${encodeURIComponent(seasonId)}`);
    const today = getLocalDateKey();
    document.getElementById('fixture-list').innerHTML = payload.fixtures.map(fixture => `
        <article class="data-card match-card${formatShortDate(fixture.match_date) < today ? ' is-past' : ''}"
            data-match-date="${escapeHtml(formatShortDate(fixture.match_date))}"
            data-fixture-season="${fixture.season_id}"
            data-home-team="${fixture.home_team_id}"
            data-away-team="${fixture.away_team_id}">
            <strong>Wk${escapeHtml(fixture.week_number ?? '-')}</strong>
            <span>${escapeHtml(fixture.match_date)} · Board ${escapeHtml(fixture.board_number ?? '-')}</span>
            <span class="match-teams">${escapeHtml(fixture.home_team)} vs ${escapeHtml(fixture.away_team)}</span>
            <div>
                <button type="button" data-edit-fixture="${fixture.id}">Edit</button>
                <button type="button" data-delete-fixture="${fixture.id}">Delete</button>
            </div>
        </article>`).join('');
}

async function loadSubmissions() {
    const seasonId = getSelectedSeasonId();
    const payload = await adminFetch(
        `/api/admin/submissions${seasonId ? `?season_id=${encodeURIComponent(seasonId)}` : ''}`
    );
    document.getElementById('submission-list').innerHTML = payload.submissions.map(submission => `
        <article class="data-card">
            <strong>${escapeHtml(submission.source)}: ${escapeHtml(submission.status)}</strong>
            <span>${escapeHtml(formatShortDate(submission.match_date))} / Board ${escapeHtml(submission.board_number || '-')}</span>
            <span>${escapeHtml(submission.home_team || '')} vs ${escapeHtml(submission.away_team || '')}</span>
            <div>
                <span>${escapeHtml(submission.turn_count)} turns</span>
                <button type="button" data-review-submission="${submission.id}">Review turns</button>
                ${submission.status === 'accepted'
                    ? `<button type="button" data-reject-submission="${submission.id}">Reject</button>`
                    : `<button type="button" data-accept-submission="${submission.id}">Accept</button>`
                }
            </div>
        </article>`).join('');
}

async function loadBackups() {
    const payload = await adminFetch('/api/admin/backups');
    document.getElementById('backup-list').innerHTML = payload.backups.length
        ? payload.backups.map(backup => `
            <article class="data-card backup-card">
                <strong>${escapeHtml(backup.filename)}</strong>
                <span>${new Date(backup.createdAt).toLocaleString()}</span>
                <span>${Math.max(1, Math.round(backup.size / 1024))} KB</span>
                <button type="button" data-download-backup="${escapeHtml(backup.filename)}">Download</button>
            </article>`).join('')
        : '<p class="empty">No backups have been created.</p>';
    const select = document.getElementById('backup-restore-file');
    select.innerHTML =
        '<option value="">Choose a backup</option>' +
        payload.backups.map(backup =>
            `<option value="${escapeHtml(backup.filename)}">${escapeHtml(backup.filename)}</option>`
        ).join('');
}

async function openSubmissionReview(submissionId) {
    const detail = await adminFetch(`/api/admin/submissions/${submissionId}`);
    const form = document.getElementById('submission-review-form');
    form.querySelector('[name="submissionId"]').value = String(submissionId);
    const submissionTeam = detail.turns.find(turn => turn.team)?.team || '';
    document.getElementById('submission-review-title').textContent =
        `${detail.submission.source}: submission ${submissionId}`;
    document.getElementById('submission-review-team').textContent =
        submissionTeam ? `from ${submissionTeam}` : '';
    document.getElementById('submission-review-summary').textContent =
        `${formatShortDate(detail.submission.match_date)} / Board ${detail.submission.board_number || '-'} · ${detail.submission.home_team || ''} vs ${detail.submission.away_team || ''}`;
    const turnsByGame = new Map();
    for (const turn of detail.turns) {
        const gameNumber = turn.game_number || 1;
        if (!turnsByGame.has(gameNumber)) turnsByGame.set(gameNumber, []);
        turnsByGame.get(gameNumber).push(turn);
    }
    document.getElementById('submission-turn-editor').innerHTML = `
        <div class="submission-turn-list" aria-label="Submission turns">
            ${[...turnsByGame.entries()].map(([gameNumber, gameTurns]) => {
                const winnerTeam = gameTurns.find(turn => turn.winner_team)?.winner_team;
                let runningRemaining = 701;
                const orderedTurns = [...gameTurns]
                    .sort((left, right) =>
                        (left.play_order ?? Number.MAX_SAFE_INTEGER) -
                        (right.play_order ?? Number.MAX_SAFE_INTEGER) ||
                        left.id - right.id
                    )
                    .map(turn => {
                    const remainingBefore = turn.remaining_before ?? runningRemaining;
                    const remainingAfter = turn.remaining_after ?? (
                        turn.is_bust
                            ? remainingBefore
                            : Math.max(0, remainingBefore - Number(turn.score || 0))
                    );
                    runningRemaining = remainingAfter;
                    return { ...turn, calculatedBefore: remainingBefore, calculatedAfter: remainingAfter };
                });
                const players = [];
                const playerTurns = new Map();
                for (const turn of orderedTurns) {
                    if (!playerTurns.has(turn.player)) {
                        players.push({ name: turn.player, team: turn.team });
                        playerTurns.set(turn.player, []);
                    }
                    playerTurns.get(turn.player).push(turn);
                }
                const maxRounds = Math.max(
                    1,
                    ...[...playerTurns.values()].map(turns => turns.length)
                );
                const checkoutTurn = orderedTurns.find(turn =>
                    turn.checkout_remaining === 0 ||
                    (turn.calculatedAfter === 0 && !turn.is_bust)
                );
                const loserTeam = winnerTeam
                    ? orderedTurns.find(turn => turn.team !== winnerTeam)?.team
                    : null;
                const winText = checkoutTurn
                    ? `${checkoutTurn.player} won with a ${checkoutTurn.score} checkout.`
                    : winnerTeam
                        ? `${winnerTeam} won.`
                        : null;
                const lossText = loserTeam ? `${loserTeam} lost.` : null;
                const outcomeHtml = winText || lossText
                    ? `${winText ? `<span class="review-game-win">${escapeHtml(winText)}</span>` : ''}
                       ${lossText ? `<span class="review-game-loss">${escapeHtml(lossText)}</span>` : ''}`
                    : '<span>Game result unavailable.</span>';
                return `
                    <section class="submission-game" data-winner-team="${escapeHtml(winnerTeam || '')}">
                        <h3>Game ${escapeHtml(gameNumber)}${winnerTeam ? ` · Winner: ${escapeHtml(winnerTeam)}` : ''}</h3>
                        <div class="review-game-layout">
                            <div class="review-table-wrap">
                                <table class="review-game-table">
                                    <thead>
                                        <tr>
                                            <th scope="col">Player</th>
                                            ${Array.from({ length: maxRounds }, (_, index) =>
                                                `<th scope="col">R${index + 1}</th>`
                                            ).join('')}
                                            <th scope="col" class="review-table-separator" aria-label="Separate score and remaining columns"></th>
                                            ${Array.from({ length: maxRounds }, (_, index) =>
                                                `<th scope="col">After R${index + 1}</th>`
                                            ).join('')}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${players.map(player => `
                                            <tr>
                                                <th scope="row">
                                                    <strong>${escapeHtml(player.name)}</strong>
                                                </th>
                                                ${Array.from({ length: maxRounds }, (_, index) => {
                                                    const turn = playerTurns.get(player.name)[index];
                                                    if (!turn) return '<td class="review-empty">—</td>';
                                                    return `
                                                        <td>
                                                            <div class="review-turn-cell"
                                                                 data-turn-id="${turn.id}"
                                                                 data-play-order="${turn.play_order ?? ''}"
                                                                 data-player="${escapeHtml(turn.player)}"
                                                                 data-team="${escapeHtml(turn.team)}"
                                                                 data-original-score="${turn.score}"
                                                                 data-original-bust="${turn.is_bust ? '1' : '0'}"
                                                                 data-original-checkout="${turn.checkout_remaining ?? ''}">
                                                                <input type="text" name="score" inputmode="numeric"
                                                                       aria-label="${escapeHtml(player.name)} round ${index + 1} score"
                                                                       value="${escapeHtml(turn.score)}">
                                                            </div>
                                                        </td>`;
                                                }).join('')}
                                                <td class="review-table-separator" aria-hidden="true"></td>
                                                ${Array.from({ length: maxRounds }, (_, index) => {
                                                    const turn = playerTurns.get(player.name)[index];
                                                    if (!turn) return '<td class="review-empty">—</td>';
                                                    return `<td class="countdown-cell" data-turn-id="${turn.id}">
                                                        <strong>${escapeHtml(turn.calculatedAfter)}</strong>
                                                    </td>`;
                                                }).join('')}
                                            </tr>`).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                        <p class="review-game-outcome">${outcomeHtml}</p>
                    </section>`;
            }).join('')}
        </div>`;
    for (const scoreInput of document.querySelectorAll('.submission-game [name="score"]')) {
        scoreInput.addEventListener('input', () => {
            recalculateSubmissionGame(scoreInput.closest('.submission-game'));
        });
    }
    form.querySelector('[name="reason"]').value = '';
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function unlock() {
    const suppliedKey = document.getElementById('admin-key').value.trim();
    authStatus.textContent = 'Checking key...';
    try {
        const response = await fetch('/api/admin/session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ key: suppliedKey })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Admin password was rejected.');
        authCard.classList.add('hidden');
        adminApp.classList.remove('hidden');
        document.getElementById('logout-admin').classList.remove('hidden');
        document.getElementById('admin-key').value = '';
        await refreshAll();
    } catch (error) {
        authStatus.textContent = error.message;
    }
}

async function refreshAll() {
    await loadSeasons();
    await loadTeams();
    await loadPlayers();
    await loadFixtures();
    await loadSubmissions();
    await loadBackups();
}

document.getElementById('unlock-admin').addEventListener('click', unlock);
document.getElementById('admin-key').addEventListener('keydown', event => {
    if (event.key === 'Enter') unlock();
});
document.getElementById('logout-admin').addEventListener('click', async () => {
    try {
        await fetch('/api/admin/session', { method: 'DELETE' });
    } finally {
        document.getElementById('logout-admin').classList.add('hidden');
        adminApp.classList.add('hidden');
        authCard.classList.remove('hidden');
        authStatus.textContent = '';
    }
});

document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.admin-panel').forEach(panel => panel.classList.remove('active'));
        button.classList.add('active');
        document.querySelector(`[data-panel="${button.dataset.tab}"]`).classList.add('active');
    });
});

document.getElementById('season-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        await adminFetch('/api/admin/seasons', {
            method: 'POST',
            body: JSON.stringify({
                name: form.get('name'),
                startDate: form.get('startDate'),
                endDate: form.get('endDate'),
                active: form.get('active') === 'on'
            })
        });
        resetForm(event.currentTarget);
        await refreshAll();
    } catch (error) { alert(error.message); }
});

document.getElementById('team-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        await adminFetch('/api/admin/teams', {
            method: 'POST',
            body: JSON.stringify({
                name: form.get('name')
            })
        });
        resetForm(event.currentTarget);
        await loadTeams();
    } catch (error) { alert(error.message); }
});

document.getElementById('player-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        await adminFetch('/api/admin/players', {
            method: 'POST',
            body: JSON.stringify({
                firstName: form.get('firstName'),
                lastName: form.get('lastName'),
                gender: form.get('gender'),
                seasonId: Number(form.get('seasonId')),
                teamId: Number(form.get('teamId'))
            })
        });
        resetForm(event.currentTarget);
        if (event.currentTarget && event.currentTarget.classList) {
            event.currentTarget.classList.add('hidden');
        }
        await loadPlayers();
    } catch (error) { alert(error.message); }
});

document.getElementById('show-player-form').addEventListener('click', () => {
    document.getElementById('player-edit-form').classList.add('hidden');
    const form = document.getElementById('player-form');
    form.classList.remove('hidden');
    form.querySelector('[name="firstName"]').focus();
});

document.getElementById('cancel-player-add').addEventListener('click', () => {
    const form = document.getElementById('player-form');
    resetForm(form);
    if (form && form.classList) form.classList.add('hidden');
});

document.getElementById('player-edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const editForm = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const status = document.getElementById('player-status');
    status.textContent = 'Saving player...';
    status.className = 'admin-status';
    try {
        await adminFetch(`/api/admin/players/${form.get('playerId')}`, {
            method: 'PUT',
            body: JSON.stringify({
                firstName: form.get('firstName'),
                lastName: form.get('lastName'),
                gender: form.get('gender')
            })
        });
        resetForm(editForm);
        editForm.classList.add('hidden');
        await loadPlayers();
        status.textContent = 'Player updated successfully.';
        status.className = 'admin-status success';
        window.clearTimeout(status.successTimer);
        status.successTimer = window.setTimeout(() => {
            status.textContent = '';
            status.className = 'admin-status';
        }, 4000);
    } catch (error) {
        status.textContent = error.message;
        status.className = 'admin-status error';
    }
});

document.getElementById('cancel-player-edit').addEventListener('click', () => {
    const form = document.getElementById('player-edit-form');
    resetForm(form);
    if (form && form.classList) form.classList.add('hidden');
});

document.getElementById('cancel-submission-review').addEventListener('click', () => {
    document.getElementById('submission-review-form').classList.add('hidden');
});

document.getElementById('submission-review-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get('reason') || '').trim();
    if (!reason) {
        alert('Enter a revision reason.');
        return;
    }
    const rows = [...document.querySelectorAll('.review-turn-cell')];
    let changedCount = 0;
    try {
        for (const row of rows) {
            const scoreText = row.querySelector('[name="score"]').value.trim();
            if (!/^\d+$/.test(scoreText)) {
                throw new Error('Turn scores must be whole numbers between 0 and 180.');
            }
            const score = Number(scoreText);
            const originalScore = Number(row.dataset.originalScore);
            const originalBust = row.dataset.originalBust === '1';
            const originalCheckout = row.dataset.originalCheckout;
            const isBust = originalBust;
            const checkout = originalCheckout === '' ? null : Number(originalCheckout);
            if (score === originalScore &&
                isBust === originalBust &&
                (checkout === null ? '' : String(checkout)) === originalCheckout) {
                continue;
            }
            if (!Number.isInteger(score) || score < 0 || score > 180) {
                throw new Error('Turn scores must be between 0 and 180.');
            }
            if (checkout !== null && (!Number.isInteger(checkout) || checkout < 0 || checkout > 170)) {
                throw new Error('Checkout remaining must be between 0 and 170.');
            }
            await adminFetch('/api/admin/submissions', {
                method: 'POST',
                body: JSON.stringify({
                    turnId: Number(row.dataset.turnId),
                    score,
                    isBust,
                    checkoutRemaining: checkout,
                    reason
                })
            });
            changedCount++;
        }
        if (!changedCount) {
            alert('No turn values changed.');
            return;
        }
        resetForm(event.currentTarget);
        if (event.currentTarget && event.currentTarget.classList) {
            event.currentTarget.classList.add('hidden');
        }
        await loadSubmissions();
    } catch (error) { alert(error.message); }
});

async function setReviewedSubmissionStatus(status) {
    const form = document.getElementById('submission-review-form');
    const submissionId = Number(form.querySelector('[name="submissionId"]').value);
    if (!submissionId) return;
    if (status === 'rejected' &&
        !confirm('Reject this submission? Its turns will not affect public reports.')) {
        return;
    }
    try {
        await adminFetch('/api/admin/submissions', {
            method: 'POST',
            body: JSON.stringify({ submissionId, status })
        });
        resetForm(form);
        if (form && form.classList) form.classList.add('hidden');
        await loadSubmissions();
    } catch (error) { alert(error.message); }
}

document.getElementById('reject-reviewed-submission').addEventListener('click', () => {
    setReviewedSubmissionStatus('rejected');
});
document.getElementById('accept-reviewed-submission').addEventListener('click', () => {
    setReviewedSubmissionStatus('accepted');
});

document.getElementById('fixture-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        await adminFetch('/api/admin/fixtures', {
            method: 'POST',
            body: JSON.stringify({
                seasonId: Number(form.get('seasonId')),
                weekNumber: form.get('weekNumber') ? Number(form.get('weekNumber')) : null,
                matchDate: form.get('matchDate'),
                boardNumber: form.get('boardNumber'),
                homeTeamId: Number(form.get('homeTeamId')),
                awayTeamId: Number(form.get('awayTeamId'))
            })
        });
        resetForm(event.currentTarget);
        if (event.currentTarget && event.currentTarget.classList) {
            event.currentTarget.classList.add('hidden');
        }
        await loadFixtures();
    } catch (error) { alert(error.message); }
});

document.getElementById('show-fixture-form').addEventListener('click', () => {
    const form = document.getElementById('fixture-form');
    form.classList.remove('hidden');
    form.querySelector('[name="weekNumber"]').focus();
});

document.getElementById('cancel-fixture-add').addEventListener('click', () => {
    const form = document.getElementById('fixture-form');
    resetForm(form);
    if (form && form.classList) form.classList.add('hidden');
});

document.getElementById('create-backup').addEventListener('click', async () => {
    const status = document.getElementById('backup-status');
    status.textContent = 'Creating backup...';
    try {
        const result = await adminFetch('/api/admin/backups/create', { method: 'POST' });
        status.textContent = `Created ${result.backup.filename}`;
        await loadBackups();
    } catch (error) {
        status.textContent = error.message;
    }
});

document.getElementById('backup-upload-form').addEventListener('submit', async event => {
    event.preventDefault();
    const fileInput = document.getElementById('backup-upload-file');
    const file = fileInput.files && fileInput.files[0];
    const status = document.getElementById('backup-status');
    if (!file) {
        status.textContent = 'Choose a .dump backup file.';
        return;
    }
    if (!file.name.toLowerCase().endsWith('.dump')) {
        status.textContent = 'The selected file must use the .dump extension.';
        return;
    }
    if (file.size > 1024 * 1024 * 1024) {
        status.textContent = 'The backup upload exceeds the 1 GB limit.';
        return;
    }
    status.textContent = `Uploading ${file.name}...`;
    try {
        const response = await fetch('/api/admin/backups/upload', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${adminKey}`,
                'Content-Type': 'application/octet-stream',
                'X-Backup-Filename': encodeURIComponent(file.name)
            },
            body: file
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'Backup upload failed.');
        status.textContent = `Uploaded ${payload.backup.filename}`;
        fileInput.value = '';
        await loadBackups();
    } catch (error) {
        status.textContent = error.message;
    }
});

document.getElementById('backup-restore-form').addEventListener('submit', async event => {
    event.preventDefault();
    const restoreForm = document.getElementById('backup-restore-form');
    const form = new FormData(restoreForm);
    const filename = String(form.get('backupFile') || '');
    const confirmation = String(form.get('confirmation') || '');
    if (!filename) {
        alert('Choose a backup to restore.');
        return;
    }
    if (confirmation !== 'RESTORE') {
        alert('Type RESTORE exactly to confirm.');
        return;
    }
    if (!confirm(`Restore the database from ${filename}? This replaces existing database objects.`)) {
        return;
    }
    const status = document.getElementById('backup-status');
    status.textContent = 'Restoring backup...';
    try {
        await adminFetch('/api/admin/backups/restore', {
            method: 'POST',
            body: JSON.stringify({ filename, confirmation })
        });
        status.textContent = `Restored ${filename}`;
        resetForm(restoreForm);
        await refreshAll();
    } catch (error) {
        status.textContent = error.message;
    }
});

document.addEventListener('click', async event => {
    const downloadBackup = event.target.closest('[data-download-backup]');
    if (downloadBackup) {
        const filename = downloadBackup.dataset.downloadBackup;
        try {
            const response = await fetch(
                `/api/admin/backups/download?file=${encodeURIComponent(filename)}`,
                { headers: { Authorization: `Bearer ${adminKey}` } }
            );
            if (!response.ok) {
                const payload = await response.json();
                throw new Error(payload.error || 'Backup download failed.');
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) { alert(error.message); }
        return;
    }
    const mergePlayer = event.target.closest('[data-merge-player]');
    if (mergePlayer) {
        const duplicateId = Number(mergePlayer.dataset.mergePlayer);
        const canonicalIdText = window.prompt(
            'Enter the player ID to keep (canonical player)',
            ''
        );
        if (canonicalIdText === null) return;
        const canonicalId = Number(canonicalIdText);
        if (!Number.isInteger(canonicalId) || canonicalId === duplicateId) {
            alert('Enter a different valid canonical player ID.');
            return;
        }
        if (!confirm('Merge this duplicate into the canonical player ID? All stats and links will move.')) {
            return;
        }
        try {
            await adminFetch('/api/admin/players/merge', {
                method: 'POST',
                body: JSON.stringify({ canonicalId, duplicateId })
            });
            await loadPlayers();
        } catch (error) { alert(error.message); }
    }
    const editPlayer = event.target.closest('[data-edit-player]');
    if (editPlayer) {
        const playerId = Number(editPlayer.dataset.editPlayer);
        const row = editPlayer.closest('.data-card');
        const playerName = row.querySelector('.player-name');
        const nameParts = playerName.textContent.trim().split(/\s+/);
        const gender = row.querySelector('.player-gender').textContent.trim();
        const form = document.getElementById('player-edit-form');
        form.querySelector('[name="playerId"]').value = String(playerId);
        form.querySelector('[name="firstName"]').value = nameParts.shift() || '';
        form.querySelector('[name="lastName"]').value = nameParts.join(' ');
        form.querySelector('[name="gender"]').value = gender;
        form.classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const deletePlayer = event.target.closest('[data-delete-player]');
    if (deletePlayer && confirm('Delete this player record?')) {
        try {
            await adminFetch(`/api/admin/players/${deletePlayer.dataset.deletePlayer}`, {
                method: 'DELETE'
            });
            await refreshAll();
        } catch (error) { alert(error.message); }
    }
    const reviewSubmission = event.target.closest('[data-review-submission]');
    if (reviewSubmission) {
        try {
            await openSubmissionReview(reviewSubmission.dataset.reviewSubmission);
        } catch (error) { alert(error.message); }
    }
    const rejectSubmission = event.target.closest('[data-reject-submission]');
    if (rejectSubmission && confirm('Reject this submission?')) {
        try {
            await adminFetch('/api/admin/submissions', {
                method: 'POST',
                body: JSON.stringify({
                    submissionId: Number(rejectSubmission.dataset.rejectSubmission),
                    status: 'rejected'
                })
            });
            await loadSubmissions();
        } catch (error) { alert(error.message); }
    }
    const acceptSubmission = event.target.closest('[data-accept-submission]');
    if (acceptSubmission) {
        try {
            await adminFetch('/api/admin/submissions', {
                method: 'POST',
                body: JSON.stringify({
                    submissionId: Number(acceptSubmission.dataset.acceptSubmission),
                    status: 'accepted'
                })
            });
            await loadSubmissions();
        } catch (error) { alert(error.message); }
    }
    const deleteTeam = event.target.closest('[data-delete-team]');
    if (deleteTeam && confirm('Delete this team?')) {
        try {
            await adminFetch(`/api/admin/teams/${deleteTeam.dataset.deleteTeam}`, { method: 'DELETE' });
            await refreshAll();
        } catch (error) { alert(error.message); }
    }
    const removePlayer = event.target.closest('[data-remove-player]');
    if (removePlayer && confirm('Remove this player from the season roster?')) {
        const ids = removePlayer.dataset.removePlayer.split(':');
        try {
            await adminFetch(`/api/admin/roster/${ids[0]}/${ids[1]}/${ids[2]}`, { method: 'DELETE' });
            await loadPlayers();
        } catch (error) { alert(error.message); }
    }
    const editFixture = event.target.closest('[data-edit-fixture]');
    if (editFixture) {
        const fixtureId = Number(editFixture.dataset.editFixture);
        const row = editFixture.closest('.data-card');
        const week = window.prompt('Week number', row.children[0].textContent.replace('Week ', '').trim());
        if (week === null) return;
        const dateAndBoard = row.children[1].textContent.split(' / Board ');
        const matchDate = window.prompt('Match date (YYYY-MM-DD)', dateAndBoard[0].trim());
        if (matchDate === null) return;
        const boardNumber = window.prompt('Board', (dateAndBoard[1] || '').replace('-', '').trim());
        if (boardNumber === null) return;
        try {
            await adminFetch(`/api/admin/fixtures/${fixtureId}`, {
                method: 'PUT',
                body: JSON.stringify({
                    seasonId: Number(row.dataset.fixtureSeason || getSelectedSeasonId()),
                    weekNumber: week === '-' ? null : Number(week),
                    matchDate,
                    boardNumber,
                    homeTeamId: Number(row.dataset.homeTeam),
                    awayTeamId: Number(row.dataset.awayTeam)
                })
            });
            await loadFixtures();
        } catch (error) { alert(error.message); }
    }
    const deleteFixture = event.target.closest('[data-delete-fixture]');
    if (deleteFixture && confirm('Delete this match?')) {
        try {
            await adminFetch(`/api/admin/fixtures/${deleteFixture.dataset.deleteFixture}`, { method: 'DELETE' });
            await loadFixtures();
        } catch (error) { alert(error.message); }
    }
});

fetch('/api/admin/session', { headers: { Accept: 'application/json' } })
    .then(response => {
        if (!response.ok) return;
        authCard.classList.add('hidden');
        adminApp.classList.remove('hidden');
        document.getElementById('logout-admin').classList.remove('hidden');
        return refreshAll();
    })
    .catch(() => {});
