const STARTING_SCORE = 701;
const SPARE_PLAYER_NAME = 'Spare';
const PLAYER_COLORS = ['#3498db', '#e67e22', '#1abc9c', '#9b59b6'];
const SELECTED_TEAM_COOKIE = 'selectedTeam';
const state = {
    teams: new Map(),
    schedule: [],
    players: [],
    teamName: '',
    opponent: '',
    matchDate: '',
    board: '',
    matchKey: null,
    rosterPlayers: [],
    lineupOrder: [],
    availablePlayers: [],
    draggedPlayer: '',
    gamesCompleted: 0,
    matchResults: [],
    playerPoints: {},
    score: STARTING_SCORE,
    currentPlayer: 0,
    history: [],
    turnDarts: [],
    turnTotal: 0,
    winner: false,
    lastTurnSnapshot: null,
    games: Array(7).fill(null),
    activeGameIndex: 0,
    gameStarted: false,
    showWinnerDialog: false,
    currentScreen: 'roster'
};

const $ = (id) => document.getElementById(id);
const SESSION_STORAGE_KEY = 'ksc-darts-scorer-session';

function createEmptyGameSlot() {
    return {
        started: false,
        lineupOrder: [],
        availablePlayers: [],
        players: [],
        score: STARTING_SCORE,
        currentPlayer: 0,
        history: [],
        turnDarts: [],
        turnTotal: 0,
        playerPoints: {},
        winner: false,
        lastTurnSnapshot: null,
        result: null
    };
}

function initializeGameSlots() {
    state.games = Array.from({ length: 7 }, createEmptyGameSlot);
    state.activeGameIndex = 0;
    state.gamesCompleted = 0;
    state.matchResults = [];
    state.lineupOrder = [];
    state.availablePlayers = [];
    state.players = [];
    state.gameStarted = false;
    state.score = STARTING_SCORE;
    state.currentPlayer = 0;
    state.history = [];
    state.turnDarts = [];
    state.turnTotal = 0;
    state.playerPoints = {};
    state.winner = false;
    state.showWinnerDialog = false;
    state.lastTurnSnapshot = null;
    state.currentScreen = 'roster';
}

function setPersistenceStatus(message) {
    document.querySelectorAll('.persistence-status').forEach(status => {
        status.textContent = message;
        status.classList.toggle('error', Boolean(message));
    });
}

function saveActiveGame() {
    if (!state.matchKey || state.games.length !== 7) return;
    state.games[state.activeGameIndex] = {
        started: state.gameStarted,
        lineupOrder: [...state.lineupOrder],
        availablePlayers: [...state.availablePlayers],
        players: state.players.map(player => ({ ...player })),
        score: state.score,
        currentPlayer: state.currentPlayer,
        history: state.history.map(turn => ({ ...turn, darts: turn.darts.map(dart => ({ ...dart })) })),
        turnDarts: state.turnDarts.map(dart => ({ ...dart })),
        turnTotal: state.turnTotal,
        playerPoints: { ...state.playerPoints },
        winner: state.winner,
        lastTurnSnapshot: state.lastTurnSnapshot,
        result: state.matchResults.find(result => result.game === state.activeGameIndex + 1) || null
    };
}

function persistSession() {
    if (!state.matchKey) return;
    try {
        saveActiveGame();
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
            version: 1,
            matchDate: state.matchDate,
            board: state.board,
            teamName: state.teamName,
            opponent: state.opponent,
            matchKey: state.matchKey,
            activeGameIndex: state.activeGameIndex,
            currentScreen: state.currentScreen,
            games: state.games
        }));
        setPersistenceStatus('');
    } catch (error) {
        setPersistenceStatus(`Could not save this match in this browser: ${error.message}`);
    }
}

function loadActiveGame() {
    const game = state.games[state.activeGameIndex];
    state.gameStarted = game.started;
    state.lineupOrder = [...game.lineupOrder];
    state.availablePlayers = [...game.availablePlayers];
    state.players = game.players.map(player => ({ ...player }));
    state.score = game.score;
    state.currentPlayer = game.currentPlayer;
    state.history = game.history.map(turn => ({ ...turn, darts: turn.darts.map(dart => ({ ...dart })) }));
    state.turnDarts = game.turnDarts.map(dart => ({ ...dart }));
    state.turnTotal = game.turnTotal;
    state.playerPoints = { ...game.playerPoints };
    state.winner = game.winner;
    state.lastTurnSnapshot = game.lastTurnSnapshot;
}

function restorePersistedSession() {
    let serialized;
    try {
        serialized = localStorage.getItem(SESSION_STORAGE_KEY);
    } catch (error) {
        setPersistenceStatus(`Could not read the saved match from this browser: ${error.message}`);
        populateDates(false);
        return true;
    }
    if (!serialized) return false;

    try {
        const saved = JSON.parse(serialized);
        if (saved.version !== 1 || !Array.isArray(saved.games) || saved.games.length !== 7 ||
            !Number.isInteger(saved.activeGameIndex) || saved.activeGameIndex < 0 || saved.activeGameIndex > 6) {
            throw new Error('The saved match data is invalid.');
        }
        const scheduledMatch = state.schedule.find(match =>
            match.date === saved.matchDate && match.teams.includes(saved.teamName)
        );
        if (!scheduledMatch) throw new Error('The saved team and match date are no longer in the schedule.');

        const savedGames = saved.games.map((game, index) => {
            if (!game || typeof game.started !== 'boolean' || !Array.isArray(game.lineupOrder) ||
                !Array.isArray(game.availablePlayers) || !Array.isArray(game.players) ||
                !Array.isArray(game.history) || !Array.isArray(game.turnDarts) ||
                !Number.isInteger(game.score) || game.score < 0 || game.score > STARTING_SCORE ||
                !Number.isInteger(game.turnTotal) || game.turnTotal < 0 || game.turnTotal > 180 ||
                !Number.isInteger(game.currentPlayer) || typeof game.winner !== 'boolean' ||
                !game.playerPoints || typeof game.playerPoints !== 'object' ||
                (game.started && (game.players.length !== 4 || game.currentPlayer > 3))) {
                throw new Error(`Saved data for Game ${index + 1} is invalid.`);
            }
            return { ...createEmptyGameSlot(), ...game };
        });

        populateDates(false);
        $('match-date').value = saved.matchDate;
        populateTeams(false);
        if (![...$('team-select').options].some(option => option.value === saved.teamName)) {
            throw new Error('The saved team is not available for that match date.');
        }
        $('team-select').value = saved.teamName;
        selectMatch(false);
        state.games = savedGames;
        state.activeGameIndex = saved.activeGameIndex;
        state.matchResults = savedGames
            .map(game => game.result)
            .filter(Boolean)
            .sort((left, right) => left.game - right.game);
        state.gamesCompleted = state.matchResults.length;
        state.currentScreen = ['roster', 'lineup', 'game'].includes(saved.currentScreen)
            ? saved.currentScreen
            : 'roster';
        loadActiveGame();

        if (state.gameStarted) {
            showGameScreen();
        } else if (state.currentScreen === 'lineup') {
            showLineupScreen();
        } else {
            state.currentScreen = 'roster';
            $('roster-screen').classList.add('active');
            updateGameNavigation();
            persistSession();
        }
        return true;
    } catch (error) {
        setPersistenceStatus(`Could not restore the saved match: ${error.message}`);
        if (!$('match-date').options.length || $('match-date').options.length === 1) populateDates(false);
        return true;
    }
}

function parseCSV(text) {
    return text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => {
        const fields = [];
        let value = '';
        let quoted = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"' && line[i + 1] === '"' && quoted) {
                value += '"';
                i++;
            } else if (char === '"') {
                quoted = !quoted;
            } else if (char === ',' && !quoted) {
                fields.push(value.trim());
                value = '';
            } else {
                value += char;
            }
        }
        fields.push(value.trim());
        return fields;
    });
}

function canonicalTeamName(name) {
    return name.replace(/\s*\(\d+\)\s*$/, '').replace(/^the\s+/i, '').trim().toLowerCase();
}

function displayTeamName(name) {
    return name.replace(/\s*\(\d+\)\s*$/, '').trim();
}

function getCookie(name) {
    const cookie = document.cookie.split('; ').find(item => item.startsWith(`${name}=`));
    if (!cookie) return '';
    try {
        return decodeURIComponent(cookie.slice(name.length + 1));
    } catch (error) {
        return '';
    }
}

function saveSelectedTeam(team) {
    document.cookie = `${SELECTED_TEAM_COOKIE}=${encodeURIComponent(team)}; max-age=31536000; path=/; SameSite=Lax`;
}

function clearSelectedTeamCookie() {
    document.cookie = `${SELECTED_TEAM_COOKIE}=; max-age=0; path=/; SameSite=Lax`;
}

function loadRosters(rows) {
    state.teams.clear();
    for (const [team, player] of rows) {
        if (!team || !player || /^team\s*name$/i.test(team) || /^player\s*name$/i.test(player)) continue;
        const key = canonicalTeamName(team);
        if (!state.teams.has(key)) state.teams.set(key, { name: team, players: [] });
        const roster = state.teams.get(key);
        if (!roster.players.includes(player)) roster.players.push(player);
    }
}

function loadSchedule(rows) {
    const header = rows[0] || [];
    const dateColumn = header.findIndex(cell => /^date$/i.test(cell));
    const boardColumn = header.findIndex(cell => /^board$/i.test(cell));
    const teamColumns = [header.findIndex(cell => /^team_?1$/i.test(cell)), header.findIndex(cell => /^team_?2$/i.test(cell))];
    if (dateColumn < 0 || boardColumn < 0 || teamColumns.some(index => index < 0)) {
        throw new Error('Schedule CSV needs date, board, team_1, and team_2 columns.');
    }
    state.schedule = rows.slice(1).filter(row => row[dateColumn]).map(row => ({
        date: row[dateColumn],
        board: row[boardColumn],
        teams: teamColumns.map(index => row[index]).filter(Boolean)
    }));
}

function showLoadError(error) {
    $('load-status').textContent = `Could not load team_lists.csv or dart_league_schedule.csv: ${error.message}. Run the app from its local web server (see README).`;
    $('load-status').classList.remove('visually-hidden');
    $('load-status').classList.add('error');
}

async function loadData() {
    $('load-status').textContent = 'Loading team rosters and schedule…';
    try {
        const [rosterResponse, scheduleResponse] = await Promise.all([
            fetch('./team_lists.csv'),
            fetch('./dart_league_schedule.csv')
        ]);
        if (!rosterResponse.ok) throw new Error(`team_lists.csv returned HTTP ${rosterResponse.status}`);
        if (!scheduleResponse.ok) throw new Error(`dart_league_schedule.csv returned HTTP ${scheduleResponse.status}`);
        loadRosters(parseCSV(await rosterResponse.text()));
        loadSchedule(parseCSV(await scheduleResponse.text()));
        if (!restorePersistedSession()) populateDates();
        $('match-date').disabled = false;
        $('load-status').classList.remove('error');
    } catch (error) {
        showLoadError(error);
    }
}

function populateDates(restoreSavedTeam = true) {
    const dates = [...new Set(state.schedule.map(match => match.date))].sort();
    $('match-date').innerHTML = '<option value="">Choose match day</option>' +
        dates.map(date => `<option value="${escapeHTML(date)}">${escapeHTML(date)}</option>`).join('');
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const defaultDate = dates.includes(today)
        ? today
        : dates.filter(date => date < today).pop() || dates[0] || '';
    $('match-date').value = defaultDate;
    $('team-select').innerHTML = '<option value="">Choose a match day first</option>';
    $('team-select').disabled = true;
    $('start-game-btn').disabled = true;
    $('opponent-name').textContent = 'Select a match day and team';
    $('board-display').textContent = '';
    if (defaultDate) populateTeams(restoreSavedTeam);
}

function populateTeams(restoreSavedTeam = false) {
    const date = $('match-date').value;
    const teams = [...new Set(state.schedule.filter(match => match.date === date).flatMap(match => match.teams))];
    $('team-select').innerHTML = '<option value="">Choose your team</option>' +
        teams.map(team => `<option value="${escapeHTML(team)}">${escapeHTML(team)}</option>`).join('');
    $('team-select').disabled = teams.length === 0;
    $('start-game-btn').disabled = true;
    $('opponent-name').textContent = 'Select your team';
    $('board-display').textContent = '';
    $('load-status').textContent = '';
    $('load-status').classList.add('visually-hidden');
    $('load-status').classList.remove('error');
    if (restoreSavedTeam) {
        const savedTeam = getCookie(SELECTED_TEAM_COOKIE);
        if (teams.includes(savedTeam)) {
            $('team-select').value = savedTeam;
            selectMatch();
        }
    }
}

function selectMatch(persist = true) {
    const scheduledTeam = $('team-select').value;
    if (!scheduledTeam) {
        clearSelectedTeamCookie();
        state.teamName = '';
        state.opponent = '';
        $('opponent-name').textContent = 'Select your team';
        $('board-display').textContent = '';
        $('start-game-btn').disabled = true;
        return;
    }

    const match = state.schedule.find(game => game.date === $('match-date').value && game.teams.includes(scheduledTeam));
    if (!match) {
        $('opponent-name').textContent = 'No scheduled opponent found.';
        $('board-display').textContent = '';
        $('start-game-btn').disabled = true;
        return;
    }

    const roster = state.teams.get(canonicalTeamName(scheduledTeam));
    const matchKey = `${match.date}|${match.board}|${scheduledTeam}`;
    if (state.matchKey !== matchKey) {
        state.matchKey = matchKey;
        initializeGameSlots();
        state.matchResults = [];
    }
    state.matchDate = match.date;
    state.board = match.board;
    state.teamName = scheduledTeam;
    saveSelectedTeam(scheduledTeam);
    state.opponent = match.teams.find(team => team !== scheduledTeam) || '';
    state.rosterPlayers = roster ? roster.players : [];
    $('opponent-name').textContent = state.opponent;
    $('board-display').textContent = state.board ? `Board ${state.board}` : '';
    $('start-game-btn').disabled = !roster || roster.players.length < 4;
    if (!roster) {
        $('load-status').textContent = `No roster found for ${scheduledTeam} in team_lists.csv.`;
        $('load-status').classList.remove('visually-hidden');
        $('load-status').classList.add('error');
    } else {
        $('load-status').textContent = '';
        $('load-status').classList.add('visually-hidden');
        $('load-status').classList.remove('error');
    }
    if (persist) persistSession();
}

function showLineupScreen() {
    if (!state.teamName || state.rosterPlayers.length < 4) return;
    if (state.gameStarted) {
        showGameScreen();
        return;
    }
    const players = state.rosterPlayers.some(player => player.toLowerCase() === SPARE_PLAYER_NAME.toLowerCase())
        ? state.rosterPlayers
        : [...state.rosterPlayers, SPARE_PLAYER_NAME];
    if (state.lineupOrder.length !== 4) {
        state.lineupOrder = players.slice(0, 4);
        state.availablePlayers = players.slice(4);
    }
    state.currentScreen = 'lineup';
    $('lineup-match-display').textContent = `${state.teamName} vs ${state.opponent}`;
    $('game-number-display').textContent = `Board ${state.board}`;
    $('roster-screen').classList.remove('active');
    $('game-screen').classList.remove('active');
    $('lineup-screen').classList.add('active');
    renderLineup();
    updateLineupStatus();
    updateGameNavigation();
    persistSession();
}

function showGameScreen() {
    state.currentScreen = 'game';
    $('roster-screen').classList.remove('active');
    $('lineup-screen').classList.remove('active');
    $('game-screen').classList.add('active');
    renderGame();
}

function renderLineup() {
    const selected = $('selected-lineup');
    const available = $('available-lineup');
    selected.replaceChildren(...state.lineupOrder.map((player, index) => createLineupItem(player, 'selected', index)));
    available.replaceChildren(...state.availablePlayers.map((player, index) => createLineupItem(player, 'available', index)));
    $('selected-count').textContent = `${state.lineupOrder.length} of 4`;
    persistSession();
}

function createLineupItem(player, zone, index) {
    const item = document.createElement('li');
    item.className = 'lineup-player-item';
    item.draggable = true;
    item.dataset.player = player;
    item.addEventListener('dragstart', event => {
        state.draggedPlayer = player;
        item.classList.add('dragging');
        event.dataTransfer.setData('text/plain', player);
        event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
        state.draggedPlayer = '';
        item.classList.remove('dragging');
    });
    item.addEventListener('dragover', event => {
        event.preventDefault();
        item.classList.add('drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
    item.addEventListener('drop', event => {
        event.preventDefault();
        event.stopPropagation();
        item.classList.remove('drop-target');
        const dragged = event.dataTransfer.getData('text/plain') || state.draggedPlayer;
        moveLineupPlayer(dragged, zone, player);
    });

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '☰';

    const name = document.createElement('span');
    name.className = 'lineup-player-name';
    name.textContent = player;
    item.append(handle);

    if (zone === 'selected') {
        const position = document.createElement('span');
        position.className = 'lineup-position';
        position.textContent = `${index + 1}.`;
        item.append(position, name);

        const actions = document.createElement('div');
        actions.className = 'lineup-item-actions';
        actions.append(
            createLineupButton('↑', `Move ${player} up`, 'order-button', () => {
                moveLineupPlayer(player, 'selected', state.lineupOrder[index - 1]);
            }, index === 0),
            createLineupButton('↓', `Move ${player} down`, 'order-button', () => {
                moveLineupPlayer(player, 'selected', state.lineupOrder[index + 1]);
            }, index === state.lineupOrder.length - 1),
            createLineupButton('Replace', `Replace ${player} with the first player below the divider`, 'lineup-action-button', () => {
                moveLineupPlayer(player, 'available');
            }, state.availablePlayers.length === 0)
        );
        item.append(actions);
    } else {
        item.append(name, createLineupButton('Add', `Add ${player} as the fourth player`, 'lineup-action-button', () => {
            moveLineupPlayer(player, 'selected');
        }));
    }

    return item;
}

function createLineupButton(text, label, className, onClick, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
}

function handleLineupDrop(event, zone) {
    event.preventDefault();
    const dragged = event.dataTransfer.getData('text/plain') || state.draggedPlayer;
    moveLineupPlayer(dragged, zone);
}

function moveLineupPlayer(player, targetZone, beforePlayer = '') {
    const sourceList = state.lineupOrder.includes(player) ? state.lineupOrder : state.availablePlayers;
    const targetList = targetZone === 'selected' ? state.lineupOrder : state.availablePlayers;
    const sourceIndex = sourceList.indexOf(player);
    if (sourceIndex < 0 || player === beforePlayer) return;
    if (sourceList === targetList) {
        const targetIndex = beforePlayer ? targetList.indexOf(beforePlayer) : -1;
        const insertAfterTarget = targetIndex >= 0 && sourceIndex < targetIndex;
        sourceList.splice(sourceIndex, 1);
        const adjustedTargetIndex = beforePlayer ? targetList.indexOf(beforePlayer) : -1;
        const insertAt = adjustedTargetIndex < 0
            ? targetList.length
            : adjustedTargetIndex + (insertAfterTarget ? 1 : 0);
        targetList.splice(insertAt, 0, player);
    } else if (targetZone === 'selected') {
        sourceList.splice(sourceIndex, 1);
        const targetIndex = beforePlayer ? targetList.indexOf(beforePlayer) : -1;
        const insertAt = targetIndex < 0 ? targetList.length - 1 : targetIndex;
        targetList.splice(insertAt, 0, player);
        if (targetList.length > 4) {
            const displaced = targetList.pop();
            state.availablePlayers.unshift(displaced);
        }
    } else {
        const replacement = state.availablePlayers[0];
        if (!replacement) {
            $('selection-status').textContent = 'No unselected player is available to replace this player.';
            return;
        }
        let availableIndex = beforePlayer ? state.availablePlayers.indexOf(beforePlayer) : state.availablePlayers.length;
        if (availableIndex < 0) availableIndex = state.availablePlayers.length;
        const replacementIndex = state.availablePlayers.indexOf(replacement);
        if (replacementIndex < availableIndex) availableIndex--;
        sourceList.splice(sourceIndex, 1);
        state.availablePlayers.splice(replacementIndex, 1);
        sourceList.splice(sourceIndex, 0, replacement);
        state.availablePlayers.splice(availableIndex, 0, player);
    }
    renderLineup();
    updateLineupStatus();
}

function updateLineupStatus() {
    const selectedCount = state.lineupOrder.length;
    $('start-selected-game-btn').disabled = selectedCount !== 4 || state.gameStarted;
    $('start-selected-game-btn').textContent = `Start Game ${state.activeGameIndex + 1} of 7`;
    $('selection-status').textContent = 'Exactly four players stay above the divider. The order from top to bottom is the play order.';
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function startGame() {
    showLineupScreen();
}

function startSelectedGame() {
    if (state.lineupOrder.length !== 4 || state.gameStarted || state.activeGameIndex >= 7) return;
    state.players = state.lineupOrder.map((name, index) => ({ name, color: PLAYER_COLORS[index] }));
    state.score = STARTING_SCORE;
    state.currentPlayer = 0;
    state.history = [];
    state.turnDarts = [];
    state.turnTotal = 0;
    state.playerPoints = Object.fromEntries(state.players.map(player => [player.name, 0]));
    state.winner = false;
    state.showWinnerDialog = false;
    state.lastTurnSnapshot = null;
    state.gameStarted = true;
    $('winner-modal').classList.add('hidden');
    showGameScreen();
}

function renderGame() {
    const teamName = displayTeamName(state.teamName);
    const opponentName = displayTeamName(state.opponent);
    $('game-match-display').textContent = `${teamName} vs ${opponentName}`;
    $('score-team-name').textContent = teamName;
    $('opponent-out-team').textContent = opponentName;
    $('opponent-out-btn').textContent = 'Click here';
    $('opponent-out-btn').setAttribute('aria-label', `Confirm that ${opponentName} won`);
    $('current-team-score').textContent = state.score;
    const finishedResult = state.winner
        ? state.matchResults.find(item => item.game === state.activeGameIndex + 1)
        : null;
    $('current-player-name').textContent = state.winner
        ? (finishedResult ? `${displayTeamName(finishedResult.winner)} won.` : '')
        : state.players[state.currentPlayer].name;
    document.querySelector('.turn-label').hidden = state.winner;
    document.querySelector('.opponent-out-action').hidden = state.winner;
    renderDartInput();
    renderHistory();
    renderCheckouts();
    updateUndoButtons();
    updateGameNavigation();
    if (state.winner && state.showWinnerDialog) renderWinnerModal();
    else $('winner-modal').classList.add('hidden');
    persistSession();
}

function renderDartInput() {
    const target = $('dart-input-section');
    if (state.winner) {
        target.innerHTML = `
            <div class="game-finished-actions">
                <button class="undo-turn-btn" id="finished-game-undo-btn" type="button" disabled>Undo Last</button>
            </div>`;
        $('finished-game-undo-btn').addEventListener('click', undoLastTurn);
        return;
    }
    const isSpare = state.players[state.currentPlayer].name.toLowerCase() === SPARE_PLAYER_NAME.toLowerCase();
    if (isSpare) {
        state.turnDarts = [];
        state.turnTotal = 25;
    }
    target.innerHTML = `
        <div class="dart-input-section">
            ${isSpare ? '<p class="spare-note">Spare automatically scores 25</p>' : ''}
            <div class="total-input-row">
                <input type="number" id="score-total-input" placeholder="Turn Total" value="${state.turnTotal || ''}" min="0" max="180" inputmode="numeric" aria-label="Turn Total">
                <button class="toggle-grid-btn" id="toggle-grid-btn" type="button">🎯 Dart Grid</button>
            </div>
            <div class="action-buttons">
                <button class="submit-score-btn" id="submit-turn-btn" type="button" disabled>Submit Turn (0)</button>
                <button class="skip-turn-btn" id="bust-turn-btn" type="button">Bust / Skip</button>
                <button class="undo-turn-btn" id="undo-turn-btn" type="button" disabled>Undo Last</button>
            </div>
            <div class="dart-grid-container" id="dart-grid-container">
                <div class="dart-grid-wrapper">
                    <div class="dart-mode-selector" role="group" aria-label="Dart multiplier">
                        <button type="button" class="dart-mode-btn active" data-multiplier="1" aria-pressed="true">Single</button>
                        <button type="button" class="dart-mode-btn" data-multiplier="2" aria-pressed="false">Double</button>
                        <button type="button" class="dart-mode-btn" data-multiplier="3" aria-pressed="false">Triple</button>
                    </div>
                    <p class="dart-grid-hint">Bull scores 25 as a single or 50 as a double.</p>
                    <div class="dart-grid">${renderDartGridButtons()}</div>
                </div>
            </div>
            <div id="turn-summary" class="turn-summary"></div>
        </div>`;
    $('score-total-input').addEventListener('input', event => {
        const value = Number(event.target.value);
        if (value > 180) {
            rejectTurnTotal('Turn totals cannot exceed 180. The score was cleared.');
            return;
        }
        state.turnTotal = Number.isInteger(value) && value >= 0 ? value : 0;
        state.turnDarts = [];
        updateTurnSummary();
    });
    $('score-total-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') submitTurn();
    });
    $('toggle-grid-btn').addEventListener('click', () => $('dart-grid-container').classList.toggle('open'));
    $('submit-turn-btn').addEventListener('click', submitTurn);
    $('bust-turn-btn').addEventListener('click', bustTurn);
    $('undo-turn-btn').addEventListener('click', undoLastTurn);
    $('start-over-btn').addEventListener('click', startTurnOver);
    let multiplier = 1;
    const bullButton = target.querySelector('[data-number="bull"]');
    target.querySelectorAll('[data-multiplier]').forEach(button => {
        button.addEventListener('click', () => {
            multiplier = Number(button.dataset.multiplier);
            target.querySelectorAll('[data-multiplier]').forEach(option => {
                const selected = option === button;
                option.classList.toggle('active', selected);
                option.setAttribute('aria-pressed', String(selected));
            });
            bullButton.disabled = multiplier === 3;
        });
    });
    target.querySelectorAll('[data-number]').forEach(button => {
        button.addEventListener('click', () => addDart(button.dataset.number, multiplier));
    });
    updateTurnSummary();
}

function renderDartGridButtons() {
    let html = '';
    for (let number = 1; number <= 20; number++) {
        html += `<button type="button" class="dart-btn dart-number-btn" data-number="${number}">${number}</button>`;
    }
    return html + '<button type="button" class="dart-btn dart-bull-btn" data-number="bull">Bull</button>' +
        '<button type="button" class="dart-btn dart-miss-btn" data-number="miss">Miss</button>' +
        '<button type="button" class="dart-btn dart-start-over-btn" id="start-over-btn">Start Over</button>';
}

function addDart(number, multiplier) {
    if (state.turnDarts.length >= 3) return;
    let dart;
    if (number === 'miss') {
        dart = { score: 0, label: 'Miss' };
    } else if (number === 'bull') {
        if (multiplier === 3) return;
        dart = multiplier === 1 ? { score: 25, label: 'SB' } : { score: 50, label: 'Bull' };
    } else {
        const label = multiplier === 1 ? 'S' : multiplier === 2 ? 'D' : 'T';
        dart = { score: Number(number) * multiplier, label: `${label}${number}` };
    }
    state.turnDarts.push(dart);
    state.turnTotal = state.turnDarts.reduce((sum, item) => sum + item.score, 0);
    $('score-total-input').value = state.turnTotal;
    updateTurnSummary();
    renderCheckouts();
}

function startTurnOver() {
    state.turnDarts = [];
    state.turnTotal = 0;
    $('score-total-input').value = '';
    updateTurnSummary();
    renderCheckouts();
}

function updateTurnSummary() {
    $('turn-summary').classList.remove('warning');
    $('submit-turn-btn').disabled = (state.turnTotal <= 0 && state.turnDarts.length === 0) || state.turnTotal > 180;
    $('submit-turn-btn').textContent = `Submit Turn (${state.turnTotal})`;
    const darts = state.turnDarts.map(dart => escapeHTML(dart.label)).join(' · ');
    $('turn-summary').textContent = state.turnTotal > 0
        ? `${darts ? `${darts} — ` : ''}Turn Total: ${state.turnTotal} · ${displayTeamName(state.teamName)} remaining: ${state.score - state.turnTotal}`
        : state.turnDarts.length
            ? `${darts} — Turn Total: 0 · ${displayTeamName(state.teamName)} remaining: ${state.score}`
        : '';
    persistSession();
}

function rejectTurnTotal(message) {
    state.turnTotal = 0;
    state.turnDarts = [];
    $('score-total-input').value = '';
    updateTurnSummary();
    $('turn-summary').textContent = message;
    $('turn-summary').classList.add('warning');
}

function submitTurn() {
    if ((state.turnTotal <= 0 && state.turnDarts.length === 0) || state.winner) return;
    const total = state.turnTotal;
    if (total > 180) {
        rejectTurnTotal('Turn totals cannot exceed 180. The score was cleared.');
        return;
    }
    const remaining = state.score - total;
    const manualEntry = state.turnDarts.length === 0;
    if (remaining === 0 && manualEntry && total % 2 !== 0) {
        rejectTurnTotal('A double-out requires an even score. Enter the score again.');
        return;
    }
    saveTurnSnapshot();
    const lastDart = state.turnDarts[state.turnDarts.length - 1];
    const assumedDoubleCheckout = remaining === 0 && manualEntry && total % 2 === 0;
    const dartCheckout = lastDart && (/^D\d+$/.test(lastDart.label) || lastDart.label === 'Bull');
    const checkout = remaining === 0 && (assumedDoubleCheckout || dartCheckout);
    const bust = remaining < 0 || remaining === 1 || (remaining === 0 && !checkout);
    state.history.push({
        player: state.players[state.currentPlayer].name,
        total,
        darts: [...state.turnDarts],
        busted: bust
    });
    if (!bust) {
        state.score = remaining;
        state.playerPoints[state.players[state.currentPlayer].name] += total;
    }
    state.turnDarts = [];
    state.turnTotal = 0;
    if (checkout && !bust) {
        finishGame();
    } else {
        state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    }
    renderGame();
    if (!state.winner) $('score-total-input').focus();
}

function bustTurn() {
    if (state.winner) return;
    saveTurnSnapshot();
    state.history.push({ player: state.players[state.currentPlayer].name, total: state.turnTotal, darts: [...state.turnDarts], busted: true });
    state.turnDarts = [];
    state.turnTotal = 0;
    state.currentPlayer = (state.currentPlayer + 1) % state.players.length;
    renderGame();
}

function saveTurnSnapshot() {
    state.lastTurnSnapshot = {
        score: state.score,
        currentPlayer: state.currentPlayer,
        history: state.history.slice(),
        turnDarts: state.turnDarts.map(dart => ({ ...dart })),
        turnTotal: state.turnTotal,
        playerPoints: { ...state.playerPoints },
        winner: state.winner,
        gamesCompleted: state.gamesCompleted,
        matchResults: state.matchResults.slice()
    };
}

function undoLastTurn() {
    const snapshot = state.lastTurnSnapshot;
    if (!snapshot) return;
    state.score = snapshot.score;
    state.currentPlayer = snapshot.currentPlayer;
    state.history = snapshot.history;
    state.turnDarts = snapshot.turnDarts;
    state.turnTotal = snapshot.turnTotal;
    state.playerPoints = snapshot.playerPoints;
    state.winner = snapshot.winner;
    state.showWinnerDialog = false;
    state.gamesCompleted = snapshot.gamesCompleted;
    state.matchResults = snapshot.matchResults;
    state.lastTurnSnapshot = null;
    $('winner-modal').classList.add('hidden');
    renderGame();
    $('score-total-input').focus();
}

function updateUndoButtons() {
    const disabled = !state.lastTurnSnapshot;
    const turnUndoButton = $('undo-turn-btn');
    if (turnUndoButton) turnUndoButton.disabled = disabled;
    const finishedGameUndoButton = $('finished-game-undo-btn');
    if (finishedGameUndoButton) finishedGameUndoButton.disabled = disabled;
    $('winner-undo-btn').disabled = disabled;
}

function finishGame(opponentWon = false) {
    if (state.winner) return;
    state.winner = true;
    state.showWinnerDialog = true;
    const gameNumber = state.activeGameIndex + 1;
    const winningTurn = opponentWon ? null : state.history[state.history.length - 1];
    const result = {
        date: state.matchDate,
        board: state.board,
        game: gameNumber,
        team: state.teamName,
        opponent: state.opponent,
        winner: opponentWon ? state.opponent : state.teamName,
        players: state.players.map(player => ({
            name: player.name,
            turns: state.history.filter(turn => turn.player === player.name).length,
            points: state.playerPoints[player.name],
            roundScores: state.history.filter(turn => turn.player === player.name).map(turn => turn.total),
            checkout: winningTurn && winningTurn.player === player.name ? winningTurn.total : ''
        }))
    };
    state.matchResults = state.matchResults
        .filter(existing => existing.game !== gameNumber)
        .concat(result)
        .sort((left, right) => left.game - right.game);
    state.gamesCompleted = state.matchResults.length;
    renderWinnerModal();
}

function renderWinnerModal() {
    const gameNumber = state.activeGameIndex + 1;
    const result = state.matchResults.find(item => item.game === gameNumber);
    const opponentWon = result && result.winner === state.opponent;
    const teamName = displayTeamName(state.teamName);
    const opponentName = displayTeamName(state.opponent);
    const winner = opponentWon ? opponentName : teamName;
    $('winner-heading').textContent = `🏆 ${winner} Wins!`;
    $('winner-summary').textContent = opponentWon
        ? `Game ${gameNumber} of 7 complete: ${opponentName} doubled out.`
        : `Game ${gameNumber} of 7 complete: ${teamName} beat ${opponentName}.`;
    $('next-game-btn').textContent = gameNumber < 7 ? `Choose lineup for Game ${gameNumber + 1}` : 'Choose another match';
    $('email-status').textContent = 'Email CSV opens a Gmail draft; Upload Results opens Dropbox. Both download the CSV first, then you must attach or select that file.';
    setServerUploadStatus('');
    $('server-upload-btn').disabled = !state.matchResults.length;
    $('email-csv-btn').href = createGmailDraftUrl();
    $('winner-modal').classList.remove('hidden');
}

function navigateToGame(gameIndex) {
    if (gameIndex < 0 || gameIndex >= 7 || gameIndex === state.activeGameIndex) return;
    saveActiveGame();
    state.activeGameIndex = gameIndex;
    state.showWinnerDialog = false;
    if (!state.games[gameIndex]) state.games[gameIndex] = createEmptyGameSlot();
    loadActiveGame();
    $('winner-modal').classList.add('hidden');
    if (state.gameStarted) showGameScreen();
    else showLineupScreen();
}

function navigateGameBy(delta) {
    navigateToGame(state.activeGameIndex + delta);
}

function updateGameNavigation() {
    document.querySelectorAll('.game-nav-label').forEach(label => {
        label.textContent = `Game ${state.activeGameIndex + 1} of 7`;
    });
    document.querySelectorAll('.game-nav-btn').forEach(button => {
        const target = state.activeGameIndex + Number(button.dataset.gameDelta);
        button.disabled = target < 0 || target >= 7;
    });
}

function csvCell(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function createResultsCSV() {
    const roundCount = Math.max(0, ...state.matchResults.flatMap(game =>
        game.players.map(player => (player.roundScores || []).length)
    ));
    const rows = [[
        'match_date', 'board', 'game', 'team', 'opponent', 'winner', 'player',
        ...Array.from({ length: roundCount }, (_, index) => `round_${index + 1}`),
        'Checkout'
    ]];
    for (const game of state.matchResults) {
        for (const player of game.players) {
            const teamWon = game.winner === game.team;
            const roundScores = teamWon ? (player.roundScores || []) : [];
            const roundColumns = Array.from({ length: roundCount }, (_, index) => roundScores[index] ?? '');
            rows.push([
                game.date, game.board, game.game, game.team, game.opponent, game.winner, player.name,
                ...roundColumns, teamWon ? player.checkout : ''
            ]);
        }
    }
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function downloadResultsCSV() {
    if (!state.matchResults.length) return;
    const csv = createResultsCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    const objectUrl = link.href;
    link.download = `701-${state.matchDate}-board-${state.board}-results.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function emailResultsCSV() {
    if (!state.matchResults.length) return;
    downloadResultsCSV();
    $('email-status').textContent = 'The CSV is downloading and a Gmail draft is opening in a new tab. Attach the downloaded CSV before sending.';
}

function uploadResultsCSV() {
    if (!state.matchResults.length) return;
    downloadResultsCSV();
    $('email-status').textContent = 'The CSV is downloading and Dropbox is opening in a new tab. Select the downloaded CSV on Dropbox to upload it.';
}

function setServerUploadStatus(message, kind = '') {
    const status = $('server-upload-status');
    status.textContent = message;
    status.classList.toggle('error', kind === 'error');
    status.classList.toggle('success', kind === 'success');
}

async function uploadResultsToServer() {
    if (!state.matchResults.length) {
        setServerUploadStatus('There are no completed games to save.', 'error');
        return;
    }
    const uploadKey = $('server-upload-key').value.trim();
    if (!uploadKey) {
        setServerUploadStatus('Enter the league upload key to save these results.', 'error');
        $('server-upload-key').focus();
        return;
    }

    const button = $('server-upload-btn');
    button.disabled = true;
    setServerUploadStatus('Saving results to the league server…');
    try {
        const response = await fetch('/api/score-uploads', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${uploadKey}`,
                'Content-Type': 'text/csv'
            },
            body: createResultsCSV()
        });
        let result = null;
        try {
            result = await response.json();
        } catch {
            result = null;
        }
        if (!response.ok) {
            throw new Error(result && result.error ? result.error : `Server returned HTTP ${response.status}.`);
        }
        if (!result || result.saved !== true) throw new Error('The server returned an invalid upload response.');
        setServerUploadStatus(`Saved ${result.rowCount} score rows to the league server.`, 'success');
    } catch (error) {
        setServerUploadStatus(`Could not save results: ${error.message}`, 'error');
    } finally {
        button.disabled = false;
    }
}

function createGmailDraftUrl() {
    const subject = `701 results - ${state.matchDate} - ${state.teamName} vs ${state.opponent}`;
    const body = 'The 701 game results CSV is downloaded. Please attach it before sending.';
    return `https://mail.google.com/mail/?view=cm&fs=1&to=speedfreqall@gmail.com&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function startNextGame() {
    $('winner-modal').classList.add('hidden');
    state.showWinnerDialog = false;
    if (state.activeGameIndex < 6) {
        navigateToGame(state.activeGameIndex + 1);
        return;
    }
    clearPersistedSession();
    state.matchKey = null;
    state.matchDate = '';
    state.board = '';
    state.matchResults = [];
    state.teamName = '';
    state.opponent = '';
    state.rosterPlayers = [];
    state.currentScreen = 'roster';
    initializeGameSlots();
    $('match-date').value = '';
    populateTeams();
    $('opponent-name').textContent = 'Select a match day and team';
    $('game-screen').classList.remove('active');
    $('lineup-screen').classList.remove('active');
    $('roster-screen').classList.add('active');
    updateGameNavigation();
}

function clearPersistedSession() {
    try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        setPersistenceStatus('');
    } catch (error) {
        setPersistenceStatus(`Could not clear the saved match from this browser: ${error.message}`);
    }
}

function renderHistory() {
    $('history-container').innerHTML = state.players.map(player => {
        const turns = state.history.filter(turn => turn.player === player.name);
        const cells = turns.map(turn => `
            <div class="history-column" title="${escapeHTML(player.name)}${turn.darts.length ? ` · ${turn.darts.map(dart => dart.label).join(', ')}` : ''}">
                <span class="history-turn-total ${turn.busted ? 'bust' : ''} ${!turn.busted && turn.total >= 95 ? 'high-score' : ''}">${turn.busted ? 'BUST' : turn.total}</span>
            </div>`).join('');
        return `<div class="history-player-block">
            <strong class="history-player-name" style="color:${player.color}">${escapeHTML(player.name)}</strong>
            <div class="history-player-turns">${cells || '<span class="empty-history">—</span>'}</div>
        </div>`;
    }).join('');
}

function handleOpponentDoubleOut() {
    if (state.winner) return;
    const confirmed = window.confirm(`Confirm that ${displayTeamName(state.opponent)} has doubled out and finish this game?`);
    if (!confirmed) return;
    state.turnDarts = [];
    state.turnTotal = 0;
    finishGame(true);
    renderGame();
}

const CHART_OUTS = {
    2: ['D1'], 3: ['S1 D1'], 4: ['D2'], 5: ['S1 D2'], 6: ['D3'],
    7: ['S3 D2'], 8: ['D4'], 9: ['S1 D4'], 10: ['D5'], 11: ['S3 D4'],
    12: ['D6'], 13: ['S11 D1'], 14: ['D7'], 15: ['S13 D1'], 16: ['D8'],
    17: ['S13 D2'], 18: ['D9'], 19: ['S11 D4'], 20: ['D10'],
    21: ['S17 D2', 'S19 D1'], 22: ['D11'], 23: ['S19 D2'], 24: ['D12'],
    25: ['S17 D4'], 26: ['D13'], 27: ['S19 D4'], 28: ['D14'],
    29: ['S17 D6'], 30: ['D15'], 31: ['S7 D12'], 32: ['D16'],
    33: ['S1 D16', 'S17 D8'], 34: ['D17'], 35: ['S3 D16', 'S19 D8'],
    36: ['D18'], 37: ['S5 D16', 'S17 D10'], 38: ['D19', 'S6 D16'],
    39: ['S7 D16', 'S19 D10'], 40: ['D20'], 41: ['S9 D16', 'S17 D12'],
    42: ['S10 D16', 'S6 D18'], 43: ['S11 D16', 'S3 D20'],
    44: ['S12 D16', 'S8 D18'], 45: ['S13 D16', 'S7 D19'],
    46: ['S14 D16', 'S6 D20'], 47: ['S15 D16', 'S19 D14'],
    48: ['S16 D16'], 49: ['S9 D20'], 50: ['T10 D10'],
    51: ['S11 D20'], 52: ['S12 D20', 'T16 D2'], 53: ['S13 D20'],
    54: ['S14 D20', 'S18 D18'], 55: ['S15 D20'], 56: ['S16 D20'],
    57: ['S17 D20'], 58: ['S18 D20'], 59: ['S19 D20'], 60: ['S20 D20'],
    61: ['SB D18', 'T11 D14'], 62: ['T10 D16', 'T12 D13'],
    63: ['T9 D18', 'T13 D12'], 64: ['T16 D8', 'T14 D11'],
    65: ['SB D20', 'T15 D10'], 66: ['T10 D18', 'T16 D9'],
    67: ['T9 D20', 'T17 D8'], 68: ['T16 D10', 'T18 D7'],
    69: ['T11 D18', 'T19 D6'], 70: ['T10 D20', 'T20 D5'],
    71: ['T13 D16', 'T19 D7'], 72: ['T16 D12'], 73: ['T19 D8'],
    74: ['T14 D16', 'T16 D13'], 75: ['T17 D12', 'SB DB'],
    76: ['T16 D14', 'T20 D8'], 77: ['T19 D10'], 78: ['T14 D18'],
    79: ['T19 D11', 'T13 D20'], 80: ['T20 D10', 'T16 D16'],
    81: ['SB 56', 'T19 D12'], 82: ['DB 32', 'T14 D20'],
    83: ['SB 58', 'T17 D16'], 84: ['SB 59', 'T20 D12'],
    85: ['SB 60', 'T15 D20'], 86: ['T18 D16'], 87: ['T17 D18'],
    88: ['T20 D14'], 89: ['T19 D16'], 90: ['T20 D15', 'T18 D18'],
    91: ['SB 66', 'T17 D20'], 92: ['SB 67', 'T20 D16'],
    93: ['SB 68', 'T19 D18'], 94: ['SB 69', 'T18 D20'],
    95: ['SB 70', 'T19 D19'], 96: ['T20 D18'], 97: ['T19 D20'],
    98: ['T20 D19'], 99: ['T19 42'], 100: ['T20 D20'],
    101: ['T20 41', 'T17 DB'], 102: ['T20 42'], 103: ['T19 46'],
    104: ['T16 56', 'T18 DB'], 105: ['T20 45'], 106: ['T20 46'],
    107: ['T19 DB'], 108: ['T16 60'], 109: ['T20 49'],
    110: ['T19 53', 'T20 DB'], 111: ['T19 54'], 112: ['T20 52'],
    113: ['T19 56'], 114: ['T19 57', 'T18 60'], 115: ['T20 55'],
    116: ['T19 S19 D20'], 117: ['T19 60'], 118: ['T20 58'],
    119: ['T19 62'], 120: ['T20 60'], 121: ['SB 96', 'T17 70'],
    122: ['T18 68'], 123: ['T19 66'], 124: ['T20 64'],
    125: ['SB 100', 'T18 71'], 126: ['T19 69'], 127: ['T20 67'],
    128: ['T18 74'], 129: ['T19 72', 'SB 104'], 130: ['T20 70'],
    131: ['T19 74'], 132: ['DB 82', 'T20 72'], 133: ['T20 73'],
    134: ['T20 74'], 135: ['DB 85', 'T20 75'], 136: ['T20 76'],
    137: ['T20 77'], 138: ['T20 78', 'T19 T19 D12'],
    139: ['T20 79', 'T19 82'], 140: ['T20 80'],
    141: ['T20 81', 'T19 84'], 142: ['T20 82', 'T19 T19 D14'],
    143: ['T20 83', 'T19 86'], 144: ['T20 84', 'T19 87'],
    145: ['T20 85', 'T19 88'], 146: ['T20 86', 'T19 T19 D16'],
    147: ['T20 87', 'T19 90'], 148: ['T20 88', 'T19 91'],
    149: ['T20 89', 'T19 92'], 150: ['T20 90', 'T19 T19 D18'],
    151: ['T20 91', 'T19 94'], 152: ['T20 92', 'T19 T19 D19'],
    153: ['T20 93', 'T19 96'], 154: ['T20 94', 'T19 97'],
    155: ['T20 95', 'T19 98'], 156: ['T20 96'], 157: ['T20 97', 'T19 100'],
    158: ['T20 98'], 160: ['T20 T20 D20'], 161: ['T20 T17 DB'],
    164: ['T20 T18 DB', 'T19 T19 DB'], 167: ['T20 T19 DB'],
    170: ['T20 T20 DB']
};

function decodeDart(code) {
    if (code === 'SB') return { score: 25, label: '25', finish: false };
    if (code === 'DB') return { score: 50, label: 'Bull', finish: true };
    const [, ring, numberText] = code.match(/^([SDT])(\d{1,2})$/) || [];
    if (!ring) return null;
    const number = Number(numberText);
    if (number < 1 || number > 20) return null;
    const multiplier = ring === 'T' ? 3 : ring === 'D' ? 2 : 1;
    return { score: number * multiplier, label: code, finish: ring === 'D' };
}

function findTwoDartFinish(score) {
    const chartLine = (CHART_OUTS[score] || []).map(route => route.split(' ').map(decodeDart).filter(Boolean))
        .find(route => route.length === 2 && route.reduce((sum, dart) => sum + dart.score, 0) === score);
    if (chartLine) return chartLine;

    const throws = [];
    for (let number = 1; number <= 20; number++) {
        throws.push(decodeDart(`T${number}`));
    }
    throws.push(decodeDart('SB'));
    for (let number = 1; number <= 20; number++) {
        throws.push(decodeDart(`S${number}`), decodeDart(`D${number}`));
    }
    for (const first of throws) {
        const lastScore = score - first.score;
        const last = lastScore === 50 ? decodeDart('DB') :
            lastScore > 0 && lastScore <= 40 && lastScore % 2 === 0 ? decodeDart(`D${lastScore / 2}`) : null;
        if (last) return [first, last];
    }
    return null;
}

function expandChartRoute(score, route, dartsAvailable) {
    const darts = route.split(' ').map(decodeDart).filter(Boolean);
    const scored = darts.reduce((sum, dart) => sum + dart.score, 0);
    if (scored === score) return darts.length <= dartsAvailable ? darts : null;
    const remainder = score - scored;
    if (remainder <= 0 || darts.length >= dartsAvailable) return null;
    const finish = findTwoDartFinish(remainder);
    if (!finish || darts.length + finish.length > dartsAvailable) return null;
    return [...darts, ...finish];
}

function findCheckouts(score, dartsAvailable = 3) {
    const routes = CHART_OUTS[score] || [];
    const options = [];
    const seen = new Set();
    for (const route of routes) {
        const checkout = expandChartRoute(score, route, dartsAvailable);
        if (!checkout) continue;
        const key = checkout.map(dart => dart.label).join('-');
        if (!seen.has(key)) {
            options.push(checkout);
            seen.add(key);
        }
    }
    return options;
}

function renderCheckouts() {
    const existing = $('checkout-section');
    if (existing) existing.remove();
    if (state.score <= 0) return;

    const score = state.score - (state.turnDarts.length ? state.turnTotal : 0);
    const dartsAvailable = 3 - state.turnDarts.length;
    if (score <= 0 || score > 170) return;
    const options = findCheckouts(score, dartsAvailable);
    const section = document.createElement('section');
    section.id = 'checkout-section';
    section.className = 'checkout-section';
    const optionsHTML = options.length
        ? options.map((option, index) => `<div class="checkout-option-row"><span class="strategy-label">${index ? 'Alternative' : 'Chart route'}</span>${option.map(dart => `<span class="checkout-dart ${dart.finish ? 'double' : ''}">${escapeHTML(dart.label)}</span>`).join(' → ')}</div>`).join('')
        : `<p>No charted checkout with ${dartsAvailable} dart${dartsAvailable === 1 ? '' : 's'} available; aim to leave a double.</p>`;
    section.innerHTML = `<h2 class="checkout-title">Checkout strategy · ${score} · ${dartsAvailable} dart${dartsAvailable === 1 ? '' : 's'} left</h2>${optionsHTML}<a class="checkout-source" href="https://ricksmith.ca/Darts/dartsouts.htm" target="_blank" rel="noopener noreferrer">Rick Smith's doubling-out chart</a>`;
    $('dart-input-section').insertAdjacentElement('afterend', section);
}

function resetToSetup() {
    saveActiveGame();
    state.currentScreen = 'roster';
    state.showWinnerDialog = false;
    $('winner-modal').classList.add('hidden');
    $('game-screen').classList.remove('active');
    $('lineup-screen').classList.remove('active');
    $('roster-screen').classList.add('active');
    updateGameNavigation();
    persistSession();
}

function restartEverything() {
    const confirmed = window.confirm('Restart everything? All game data, including scores, histories, results, and saved progress, will be cleared.');
    if (!confirmed) return;
    clearPersistedSession();
    initializeGameSlots();
    $('winner-modal').classList.add('hidden');
    $('game-screen').classList.remove('active');
    $('lineup-screen').classList.remove('active');
    $('roster-screen').classList.add('active');
    updateGameNavigation();
}

$('match-date').addEventListener('change', populateTeams);
$('team-select').addEventListener('change', selectMatch);
$('game-screen').querySelectorAll('.game-nav-btn').forEach(button => {
    button.addEventListener('click', () => navigateGameBy(Number(button.dataset.gameDelta)));
});
$('lineup-screen').querySelectorAll('.game-nav-btn').forEach(button => {
    button.addEventListener('click', () => navigateGameBy(Number(button.dataset.gameDelta)));
});
$('start-game-btn').addEventListener('click', startGame);
$('start-selected-game-btn').addEventListener('click', startSelectedGame);
[
    ['selected-lineup', 'selected'],
    ['available-lineup', 'available']
].forEach(([id, zone]) => {
    const list = $(id);
    list.addEventListener('dragover', event => event.preventDefault());
    list.addEventListener('drop', event => handleLineupDrop(event, zone));
});
$('back-to-match').addEventListener('click', resetToSetup);
$('back-to-roster').addEventListener('click', restartEverything);
$('opponent-out-btn').addEventListener('click', handleOpponentDoubleOut);
$('winner-undo-btn').addEventListener('click', undoLastTurn);
$('next-game-btn').addEventListener('click', startNextGame);
$('email-csv-btn').addEventListener('click', emailResultsCSV);
$('upload-results-btn').addEventListener('click', uploadResultsCSV);
$('download-csv-btn').addEventListener('click', downloadResultsCSV);
$('server-upload-btn').addEventListener('click', uploadResultsToServer);
loadData();
