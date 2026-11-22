'use strict';

let activeReport = 'standings';
let activeCategory = 'overall';
let selectedSeason = '';

const seasonSelect = document.getElementById('season-select');
const reportStatus = document.getElementById('report-status');
const reportContent = document.getElementById('report-content');
const subtabs = document.getElementById('subtabs');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Report could not be loaded.');
    return payload;
}

function seasonQuery() {
    return selectedSeason ? `?season_id=${encodeURIComponent(selectedSeason)}` : '';
}

function parseSortableValue(value) {
    const text = String(value ?? '').trim();
    const normalized = text.replace(/,/g, '');
    if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
        return { numeric: true, value: Number(normalized) };
    }
    return { numeric: false, value: text };
}

function sortReportTable(table, columnIndex) {
    const header = table.querySelectorAll('thead th')[columnIndex];
    if (!header) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const currentDirection = table.dataset.sortDirection || '';
    const currentIndex = table.dataset.sortIndex;
    const direction = currentIndex === String(columnIndex) && currentDirection === 'asc'
        ? 'desc'
        : 'asc';
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((left, right) => {
        const leftValue = parseSortableValue(left.cells[columnIndex]?.textContent);
        const rightValue = parseSortableValue(right.cells[columnIndex]?.textContent);
        let comparison;
        if (leftValue.numeric && rightValue.numeric) {
            comparison = leftValue.value - rightValue.value;
        } else {
            comparison = String(leftValue.value).localeCompare(
                String(rightValue.value),
                undefined,
                { sensitivity: 'base', numeric: true }
            );
        }
        return direction === 'asc' ? comparison : -comparison;
    });
    rows.forEach(row => tbody.appendChild(row));
    table.dataset.sortIndex = String(columnIndex);
    table.dataset.sortDirection = direction;

    table.querySelectorAll('thead th').forEach((th, index) => {
        th.setAttribute('aria-sort', index === columnIndex
            ? (direction === 'asc' ? 'ascending' : 'descending')
            : 'none');
        const indicator = th.querySelector('.sort-indicator');
        if (indicator) {
            indicator.textContent = index === columnIndex
                ? (direction === 'asc' ? '▲' : '▼')
                : '↕';
        }
    });
}

function renderTable(rows, columns) {
    if (!rows.length) {
        reportContent.innerHTML = '<p class="empty">No accepted results are available for this report.</p>';
        return;
    }

    reportContent.innerHTML = `
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>${columns.map((column, index) => `
                        <th scope="col" aria-sort="none"${column.numeric ? ' class="numeric"' : ''}>
                            <button type="button" class="sort-header" data-sort-index="${index}">
                                ${escapeHtml(column.label)}
                                <span class="sort-indicator" aria-hidden="true">↕</span>
                            </button>
                        </th>`).join('')}</tr>
                </thead>
                <tbody>
                    ${rows.map(row => `
                        <tr>${columns.map(column => `<td${column.numeric ? ' class="numeric"' : ''}>${escapeHtml(row[column.key])}</td>`).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        </div>`;
}

async function loadReport() {
    reportStatus.textContent = 'Loading report...';
    reportContent.innerHTML = '';
    try {
        if (activeReport === 'standings') {
            const payload = await fetchJson(`/api/reports/standings${seasonQuery()}`);
            renderTable(payload.standings, [
                { key: 'team', label: 'Team' },
                { key: 'wins', label: 'Wins' },
                { key: 'losses', label: 'Losses' },
                { key: 'games', label: 'Games' },
                { key: 'average', label: 'Avg.' }
            ]);
        } else if (activeReport === 'leaders') {
            const payload = await fetchJson(`/api/reports/leaders${seasonQuery()}`);
            const columns = [
                { key: 'player', label: 'Player' },
                { key: 'team', label: 'Team' },
                { key: 'average', label: 'Avg.' },
                { key: '95+', label: '95+' },
                { key: 'outs', label: 'Outs' }
            ];
            reportContent.innerHTML = `
                <div class="leader-grid">
                    <section><h2>Mens</h2>${createTable(payload.mens, columns)}</section>
                    <section><h2>Ladies</h2>${createTable(payload.ladies, columns)}</section>
                </div>`;
        } else {
            const gender = activeReport === 'mens' ? 'mens' : 'lady';
            const payload = await fetchJson(
                `/api/reports/${gender}-${activeCategory}${seasonQuery()}`
            );
            const categoryColumns = {
                overall: [
                    { key: 'player', label: 'Player' },
                    { key: 'team', label: 'Team' },
                    { key: 'gp', label: 'GP', numeric: true },
                    { key: 'shots', label: 'Shots', numeric: true },
                    { key: 'score', label: 'Score', numeric: true },
                    { key: 'average', label: 'Avg.', numeric: true },
                    { key: '95+', label: '95+', numeric: true },
                    { key: 'outs', label: 'Outs', numeric: true },
                    { key: 'HM', label: 'Hon. Mentions', numeric: true },
                    { key: '50+Fin.', label: '50+Fin.', numeric: true }
                ],
                avg: [
                    { key: 'player', label: 'Player' },
                    { key: 'team', label: 'Team' },
                    { key: 'average', label: 'Avg.' }
                ],
                '95': [
                    { key: 'player', label: 'Player' },
                    { key: 'team', label: 'Team' },
                    { key: '95+', label: '95+' }
                ],
                outs: [
                    { key: 'player', label: 'Player' },
                    { key: 'team', label: 'Team' },
                    { key: 'outs', label: 'Outs' }
                ],
                honourable: [
                    { key: 'player', label: 'Player' },
                    { key: 'team', label: 'Team' },
                    { key: 'score', label: 'Score' }
                ]
            };
            renderTable(payload.players, categoryColumns[activeCategory]);
        }
        reportStatus.textContent = '';
    } catch (error) {
        reportStatus.textContent = error.message;
        reportContent.innerHTML = '';
    }
}

function createTable(rows, columns) {
    if (!rows.length) return '<p class="empty">No accepted results.</p>';
    return `
        <div class="table-wrap">
            <table>
                <thead><tr>${columns.map((column, index) => `
                    <th scope="col" aria-sort="none">
                        <button type="button" class="sort-header" data-sort-index="${index}">
                            ${escapeHtml(column.label)}
                            <span class="sort-indicator" aria-hidden="true">↕</span>
                        </button>
                    </th>`).join('')}</tr></thead>
                <tbody>
                    ${rows.map(row => `<tr>${columns.map(column =>
                        `<td>${escapeHtml(row[column.key])}</td>`).join('')}</tr>`).join('')}
                </tbody>
            </table>
        </div>`;
}

async function initialize() {
    try {
        const payload = await fetchJson('/api/seasons');
        seasonSelect.innerHTML = payload.seasons.map(season =>
            `<option value="${escapeHtml(season.id)}">${escapeHtml(season.name)}${season.active ? ' (active)' : ''}</option>`
        ).join('');
        const active = payload.seasons.find(season => season.active);
        selectedSeason = active ? String(active.id) : (payload.seasons[0] ? String(payload.seasons[0].id) : '');
        seasonSelect.value = selectedSeason;
        seasonSelect.disabled = false;
        await loadReport();
    } catch (error) {
        reportStatus.textContent = error.message;
        seasonSelect.disabled = true;
    }
}

seasonSelect.addEventListener('change', () => {
    selectedSeason = seasonSelect.value;
    loadReport();
});

document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
        button.classList.add('active');
        activeReport = button.dataset.report;
        subtabs.classList.toggle('hidden', !['mens', 'ladies'].includes(activeReport));
        loadReport();
    });
});

document.querySelectorAll('.subtab').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.subtab').forEach(tab => tab.classList.remove('active'));
        button.classList.add('active');
        activeCategory = button.dataset.category;
        loadReport();
    });
});

reportContent.addEventListener('click', event => {
    const sortButton = event.target.closest('.sort-header');
    if (!sortButton) return;
    const table = sortButton.closest('table');
    if (!table) return;
    sortReportTable(table, Number(sortButton.dataset.sortIndex));
});

initialize();
