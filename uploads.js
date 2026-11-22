'use strict';

const $ = id => document.getElementById(id);
const keyInput = $('upload-key');
const loadButton = $('load-uploads-btn');
const exportButton = $('export-uploads-btn');
const selectAll = $('select-all-uploads');
const status = $('uploads-status');
const list = $('uploads-list');

function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
}

async function readJsonResponse(response) {
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`The server returned a non-JSON response (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(data.error || `The server returned HTTP ${response.status}.`);
    return data;
}

function selectedUploads() {
    return [...list.querySelectorAll('.upload-selection:checked')].map(input => ({
        matchDate: input.dataset.matchDate,
        board: input.dataset.board,
        team: input.dataset.team
    }));
}

function updateSelectionControls() {
    const checkboxes = [...list.querySelectorAll('.upload-selection')];
    const selectedCount = checkboxes.filter(input => input.checked).length;
    selectAll.disabled = checkboxes.length === 0;
    selectAll.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
    exportButton.disabled = selectedCount === 0;
}

function formatUploadTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString();
}

function formatMatchDate(value) {
    if (!value) return '';
    const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime())
        ? String(value)
        : date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
}

function renderUploads(uploads) {
    list.replaceChildren();
    if (!uploads.length) {
        const empty = document.createElement('p');
        empty.className = 'uploads-empty';
        empty.textContent = 'No score uploads have been saved yet.';
        list.appendChild(empty);
        updateSelectionControls();
        return;
    }

    const table = document.createElement('table');
    table.className = 'uploads-table';
    const head = table.createTHead().insertRow();
    for (const title of ['', 'Match date', 'Board', 'Team', 'Opponent', 'Score rows', 'Uploaded']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = title;
        head.appendChild(cell);
    }
    const body = table.createTBody();
    for (const upload of uploads) {
        const row = body.insertRow();
        const selectionCell = row.insertCell();
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'upload-selection';
        checkbox.setAttribute('aria-label', `Select ${upload.matchDate}, board ${upload.board}, ${upload.team}`);
        checkbox.dataset.matchDate = upload.matchDate;
        checkbox.dataset.board = upload.board;
        checkbox.dataset.team = upload.team;
        selectionCell.appendChild(checkbox);

        for (const value of [
            formatMatchDate(upload.matchDate),
            upload.board,
            upload.team,
            upload.opponent,
            upload.rowCount,
            formatUploadTime(upload.uploadedAt)
        ]) {
            row.insertCell().textContent = String(value ?? '');
        }
    }
    list.appendChild(table);
    updateSelectionControls();
}

async function loadUploads() {
    const key = keyInput.value.trim();
    if (!key) {
        setStatus('Enter the league upload key to view saved scores.', true);
        keyInput.focus();
        return;
    }

    loadButton.disabled = true;
    setStatus('Loading saved scores…');
    try {
        const response = await fetch('/api/score-uploads/list', {
            headers: { Authorization: `Bearer ${key}` }
        });
        const data = await readJsonResponse(response);
        renderUploads(data.uploads);
        setStatus(`${data.uploads.length} upload${data.uploads.length === 1 ? '' : 's'} found.`);
    } catch (error) {
        renderUploads([]);
        setStatus(error.message, true);
    } finally {
        loadButton.disabled = false;
    }
}

async function exportSelectedUploads() {
    const uploads = selectedUploads();
    if (!uploads.length) return;

    exportButton.disabled = true;
    setStatus('Preparing Excel workbook…');
    try {
        const response = await fetch('/api/score-uploads/export', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${keyInput.value.trim()}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ uploads })
        });
        if (!response.ok) {
            const data = await readJsonResponse(response);
            throw new Error(data.error || `The server returned HTTP ${response.status}.`);
        }

        const workbook = await response.blob();
        const objectUrl = URL.createObjectURL(workbook);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = '701-score-uploads.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        setStatus(`Downloaded ${uploads.length} selected upload${uploads.length === 1 ? '' : 's'} as CSV.`);
    } catch (error) {
        setStatus(error.message, true);
    } finally {
        updateSelectionControls();
    }
}

loadButton.addEventListener('click', loadUploads);
exportButton.addEventListener('click', exportSelectedUploads);
selectAll.addEventListener('change', () => {
    list.querySelectorAll('.upload-selection').forEach(input => {
        input.checked = selectAll.checked;
    });
    updateSelectionControls();
});
list.addEventListener('change', event => {
    if (event.target.matches('.upload-selection')) updateSelectionControls();
});
