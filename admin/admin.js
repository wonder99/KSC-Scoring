// Admin Dashboard JavaScript

// Global variables
let currentTab = 'score-review';
const ADMIN_API_KEY = 'your-admin-api-key-here'; // This should be set securely in production

// DOM Elements
const tabButtons = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');
const scoresTableBody = document.getElementById('scores-table-body');
const teamsTableBody = document.getElementById('teams-table-body');
const scheduleGrid = document.getElementById('schedule-grid');
const teamForm = document.getElementById('team-form');
const refreshScoresBtn = document.getElementById('refresh-scores');
const refreshScheduleBtn = document.getElementById('refresh-schedule');
const addTeamBtn = document.getElementById('add-team-btn');

// Initialize the admin dashboard
document.addEventListener('DOMContentLoaded', function() {
    // Set up tab navigation
    setupTabNavigation();
    
    // Load initial data
    loadScoreReviewData();
    loadTeamManagementData();
    loadScheduleData();
    
    // Set up event listeners
    setupEventListeners();
});

// Set up tab navigation
function setupTabNavigation() {
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Remove active class from all buttons and contents
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabContents.forEach(content => content.classList.remove('active'));
            
            // Add active class to clicked button and corresponding content
            button.classList.add('active');
            const tabId = button.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
            
            currentTab = tabId;
        });
    });
}

// Set up event listeners
function setupEventListeners() {
    // Team form submission
    teamForm.addEventListener('submit', handleTeamSubmit);
    
    // Refresh buttons
    refreshScoresBtn.addEventListener('click', loadScoreReviewData);
    refreshScheduleBtn.addEventListener('click', loadScheduleData);
    
    // Add team button
    addTeamBtn.addEventListener('click', () => {
        document.querySelector('#team-management .admin-card:last-child').scrollIntoView({ behavior: 'smooth' });
    });
}

// Load score review data
function loadScoreReviewData() {
    showLoading(true, scoresTableBody);
    
    fetch('/api/admin/scores', {
        method: 'GET',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        renderScoresTable(data);
    })
    .catch(error => {
        console.error('Error loading scores:', error);
        scoresTableBody.innerHTML = '<tr><td colspan="6">Error loading scores. Please try again.</td></tr>';
    })
    .finally(() => {
        showLoading(false, scoresTableBody);
    });
}

// Render scores table
function renderScoresTable(scores) {
    scoresTableBody.innerHTML = '';
    
    if (!scores || scores.length === 0) {
        scoresTableBody.innerHTML = '<tr><td colspan="6">No scores found.</td></tr>';
        return;
    }
    
    scores.forEach(score => {
        const row = document.createElement('tr');
        
        // Format date
        const date = new Date(score.date);
        const formattedDate = date.toLocaleDateString();
        
        row.innerHTML = `
            <td>${formattedDate}</td>
            <td>${score.teamA}</td>
            <td>${score.teamB}</td>
            <td>${score.scoreA}</td>
            <td>${score.scoreB}</td>
            <td>
                <button class="btn btn-danger" onclick="deleteScore('${score.id}')">Delete</button>
                <button class="btn btn-secondary" onclick="recalculateScore('${score.id}')">Recalculate</button>
            </td>
        `;
        
        scoresTableBody.appendChild(row);
    });
}

// Delete a score
function deleteScore(scoreId) {
    if (!confirm('Are you sure you want to delete this score?')) {
        return;
    }
    
    fetch(`/api/admin/scores/${scoreId}`, {
        method: 'DELETE',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(() => {
        // Reload scores after deletion
        loadScoreReviewData();
    })
    .catch(error => {
        console.error('Error deleting score:', error);
        alert('Error deleting score. Please try again.');
    });
}

// Recalculate a score
function recalculateScore(scoreId) {
    if (!confirm('Are you sure you want to recalculate this score?')) {
        return;
    }
    
    fetch(`/api/admin/scores/${scoreId}/recalculate`, {
        method: 'POST',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(() => {
        // Reload scores after recalculation
        loadScoreReviewData();
    })
    .catch(error => {
        console.error('Error recalculating score:', error);
        alert('Error recalculating score. Please try again.');
    });
}

// Load team management data
function loadTeamManagementData() {
    showLoading(true, teamsTableBody);
    
    fetch('/api/admin/teams', {
        method: 'GET',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        renderTeamsTable(data);
    })
    .catch(error => {
        console.error('Error loading teams:', error);
        teamsTableBody.innerHTML = '<tr><td colspan="3">Error loading teams. Please try again.</td></tr>';
    })
    .finally(() => {
        showLoading(false, teamsTableBody);
    });
}

// Render teams table
function renderTeamsTable(teams) {
    teamsTableBody.innerHTML = '';
    
    if (!teams || teams.length === 0) {
        teamsTableBody.innerHTML = '<tr><td colspan="3">No teams found.</td></tr>';
        return;
    }
    
    teams.forEach(team => {
        const row = document.createElement('tr');
        
        // Format players
        const players = team.players.join(', ');
        
        row.innerHTML = `
            <td>${team.name}</td>
            <td>${players}</td>
            <td>
                <button class="btn btn-danger" onclick="deleteTeam('${team.id}')">Delete</button>
            </td>
        `;
        
        teamsTableBody.appendChild(row);
    });
}

// Handle team form submission
function handleTeamSubmit(event) {
    event.preventDefault();
    
    const teamName = document.getElementById('team-name').value;
    const player1 = document.getElementById('player1').value;
    const player2 = document.getElementById('player2').value;
    
    // Prepare team data
    const teamData = {
        name: teamName,
        players: [player1]
    };
    
    if (player2.trim() !== '') {
        teamData.players.push(player2);
    }
    
    fetch('/api/admin/teams', {
        method: 'POST',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(teamData)
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(() => {
        // Reset form
        teamForm.reset();
        
        // Reload teams
        loadTeamManagementData();
        
        alert('Team added successfully!');
    })
    .catch(error => {
        console.error('Error adding team:', error);
        alert('Error adding team. Please try again.');
    });
}

// Delete a team
function deleteTeam(teamId) {
    if (!confirm('Are you sure you want to delete this team?')) {
        return;
    }
    
    fetch(`/api/admin/teams/${teamId}`, {
        method: 'DELETE',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(() => {
        // Reload teams after deletion
        loadTeamManagementData();
    })
    .catch(error => {
        console.error('Error deleting team:', error);
        alert('Error deleting team. Please try again.');
    });
}

// Load schedule data
function loadScheduleData() {
    showLoading(true, scheduleGrid);
    
    fetch('/api/admin/schedule', {
        method: 'GET',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        renderScheduleGrid(data);
    })
    .catch(error => {
        console.error('Error loading schedule:', error);
        scheduleGrid.innerHTML = '<p>Error loading schedule. Please try again.</p>';
    })
    .finally(() => {
        showLoading(false, scheduleGrid);
    });
}

// Render schedule grid
function renderScheduleGrid(matches) {
    scheduleGrid.innerHTML = '';
    
    if (!matches || matches.length === 0) {
        scheduleGrid.innerHTML = '<p>No upcoming matches found.</p>';
        return;
    }
    
    matches.forEach(match => {
        const card = document.createElement('div');
        card.className = 'schedule-card';
        
        // Format date
        const date = new Date(match.date);
        const formattedDate = date.toLocaleDateString();
        
        // Format time
        const time = date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        card.innerHTML = `
            <h4>${match.teamA} vs ${match.teamB}</h4>
            <p><strong>Date:</strong> ${formattedDate}</p>
            <p><strong>Time:</strong> ${time}</p>
            <p><strong>Venue:</strong> ${match.venue || 'Not specified'}</p>
            <div class="match-actions">
                <button class="btn btn-secondary" onclick="editMatch('${match.id}')">Edit</button>
                <button class="btn btn-danger" onclick="deleteMatch('${match.id}')">Delete</button>
            </div>
        `;
        
        scheduleGrid.appendChild(card);
    });
}

// Edit a match (placeholder function)
function editMatch(matchId) {
    alert(`Edit functionality for match ${matchId} would be implemented here.`);
    // In a real implementation, this would open an inline edit form or modal
}

// Delete a match
function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) {
        return;
    }
    
    fetch(`/api/admin/schedule/${matchId}`, {
        method: 'DELETE',
        headers: {
            'ADMIN_API_KEY': ADMIN_API_KEY,
            'Content-Type': 'application/json'
        }
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(() => {
        // Reload schedule after deletion
        loadScheduleData();
    })
    .catch(error => {
        console.error('Error deleting match:', error);
        alert('Error deleting match. Please try again.');
    });
}

// Show/hide loading indicator
function showLoading(show, element) {
    if (show) {
        element.innerHTML = '<tr><td colspan="100" class="loading">Loading...</td></tr>';
    } else {
        // Clear loading indicator but keep existing content
    }
}