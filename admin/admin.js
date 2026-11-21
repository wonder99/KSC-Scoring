'use strict';

let adminKey = sessionStorage.getItem('701-admin-key') || '';
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

async function adminFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${adminKey}`,
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
    document.getElementById('fixture-list').innerHTML = payload.fixtures.map(fixture => `
        <article class="data-card match-card"
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
            <span>${escapeHtml(submission.match_date || 'Unknown date')} / Board ${escapeHtml(submission.board_number || '-')}</span>
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
    document.getElementById('submission-review-title').textContent =
        `${detail.submission.source}: submission ${submissionId}`;
    document.getElementById('submission-review-summary').textContent =
        `${detail.submission.match_date || 'Unknown date'} / Board ${detail.submission.board_number || '-'} · ${detail.submission.home_team || ''} vs ${detail.submission.away_team || ''}`;
    document.getElementById('submission-turn-editor').innerHTML =
        detail.turns.map(turn => `
            <div class="submission-turn-row"
                 data-turn-id="${turn.id}"
                 data-original-score="${turn.score}"
                 data-original-bust="${turn.is_bust ? '1' : '0'}"
                 data-original-checkout="${turn.checkout_remaining ?? ''}">
                <strong>${escapeHtml(turn.player)} · Turn ${escapeHtml(turn.turn_number)} · ${escapeHtml(turn.team)}</strong>
                <label>Score
                    <input type="number" name="score" min="0" max="180" value="${escapeHtml(turn.score)}">
                </label>
                <label>Checkout
                    <input type="number" name="checkout" min="0" max="170" value="${escapeHtml(turn.checkout_remaining ?? '')}">
                </label>
                <label>
                    <input type="checkbox" name="bust" ${turn.is_bust ? 'checked' : ''}>
                    Bust
                </label>
            </div>`).join('');
    form.querySelector('[name="reason"]').value = '';
    form.classList.remove('hidden');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function unlock() {
    adminKey = document.getElementById('admin-key').value.trim();
    authStatus.textContent = 'Checking key...';
    try {
        await adminFetch('/api/admin/seasons');
        sessionStorage.setItem('701-admin-key', adminKey);
        authCard.classList.add('hidden');
        adminApp.classList.remove('hidden');
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
        event.currentTarget.reset();
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
        event.currentTarget.reset();
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
        event.currentTarget.reset();
        event.currentTarget.classList.add('hidden');
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
    form.reset();
    form.classList.add('hidden');
});

document.getElementById('player-edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
        await adminFetch(`/api/admin/players/${form.get('playerId')}`, {
            method: 'PUT',
            body: JSON.stringify({
                firstName: form.get('firstName'),
                lastName: form.get('lastName'),
                gender: form.get('gender')
            })
        });
        event.currentTarget.reset();
        event.currentTarget.classList.add('hidden');
        await loadPlayers();
    } catch (error) { alert(error.message); }
});

document.getElementById('cancel-player-edit').addEventListener('click', () => {
    const form = document.getElementById('player-edit-form');
    form.reset();
    form.classList.add('hidden');
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
    const rows = [...document.querySelectorAll('.submission-turn-row')];
    let changedCount = 0;
    try {
        for (const row of rows) {
            const score = Number(row.querySelector('[name="score"]').value);
            const checkoutText = row.querySelector('[name="checkout"]').value.trim();
            const isBust = row.querySelector('[name="bust"]').checked;
            const originalScore = Number(row.dataset.originalScore);
            const originalBust = row.dataset.originalBust === '1';
            const originalCheckout = row.dataset.originalCheckout;
            const checkout = checkoutText === '' ? null : Number(checkoutText);
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
        event.currentTarget.reset();
        event.currentTarget.classList.add('hidden');
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
        form.reset();
        form.classList.add('hidden');
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
        event.currentTarget.reset();
        event.currentTarget.classList.add('hidden');
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
    form.reset();
    form.classList.add('hidden');
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

document.getElementById('backup-restore-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
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
        event.currentTarget.reset();
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

if (adminKey) {
    document.getElementById('admin-key').value = adminKey;
    unlock();
}
