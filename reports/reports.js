// Tab switching functionality
document.addEventListener('DOMContentLoaded', function() {
    // Main tab switching
    const tabButtons = document.querySelectorAll('.tab-button');
    const subTabButtons = document.querySelectorAll('.sub-tab-button');
    const tabContents = document.querySelectorAll('.tab-content');

    // Handle main tab clicks
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabId = button.getAttribute('data-tab');
            
            // Update active main tab
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            
            // Show corresponding content
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === tabId) {
                    content.classList.add('active');
                }
            });
            
            // Load data for the active tab
            loadDataForTab(tabId);
        });
    });

    // Handle sub-tab clicks
    subTabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const subTabId = button.getAttribute('data-subtab');
            const parentTab = button.closest('.tab-content').id;
            
            // Update active sub-tab
            const parentSubTabs = document.querySelectorAll(`#${parentTab} .sub-tab-button`);
            parentSubTabs.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            
            // Load data for the specific sub-tab
            loadDataForTab(parentTab, subTabId);
        });
    });

    // Initialize with standings tab active
    loadDataForTab('standings');
});

// Function to load data for different tabs
function loadDataForTab(tabId, subTabId = null) {
    const container = document.getElementById(`${tabId}-container`) || 
                     document.getElementById(`${tabId}-table-container`);
    
    if (!container) return;

    // Show loading state
    container.innerHTML = '<div class="loading">Loading data...</div>';

    let endpoint = '';
    
    switch(tabId) {
        case 'standings':
            endpoint = '/api/reports/standings';
            break;
        case 'mens-stats':
            if (subTabId) {
                endpoint = `/api/reports/mens-stats/${subTabId}`;
            } else {
                // Default to overall stats
                endpoint = '/api/reports/mens-stats/overall';
            }
            break;
        case 'lady-stats':
            if (subTabId) {
                endpoint = `/api/reports/lady-stats/${subTabId}`;
            } else {
                // Default to overall stats
                endpoint = '/api/reports/lady-stats/overall';
            }
            break;
        case 'leaders':
            endpoint = '/api/reports/leaders';
            break;
        default:
            return;
    }

    fetch(endpoint)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            renderTable(container, data);
        })
        .catch(error => {
            console.error('Error fetching data:', error);
            container.innerHTML = `<div class="error">Failed to load data: ${error.message}</div>`;
        });
}

// Function to render tables
function renderTable(container, data) {
    if (!data || data.length === 0) {
        container.innerHTML = '<p>No data available</p>';
        return;
    }

    // Create table element
    const table = document.createElement('table');
    
    // Create header row
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    
    // Get column headers from first data item
    const headers = Object.keys(data[0]);
    headers.forEach(header => {
        const th = document.createElement('th');
        th.textContent = header.charAt(0).toUpperCase() + header.slice(1).replace(/([A-Z])/g, ' $1');
        headerRow.appendChild(th);
    });
    
    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    // Create body
    const tbody = document.createElement('tbody');
    
    data.forEach(row => {
        const tr = document.createElement('tr');
        
        headers.forEach(header => {
            const td = document.createElement('td');
            
            // Handle special formatting for certain fields
            if (header === 'avg' || header === 'score') {
                td.textContent = row[header].toFixed(2);
            } else if (header === 'percentage') {
                td.textContent = `${row[header].toFixed(2)}%`;
            } else {
                td.textContent = row[header];
            }
            
            tr.appendChild(td);
        });
        
        tbody.appendChild(tr);
    });
    
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
}

// Function to handle dropdown toggle
function setupDropdowns() {
    const dropdowns = document.querySelectorAll('.dropdown');
    
    dropdowns.forEach(dropdown => {
        const button = dropdown.querySelector('.tab-button');
        const content = dropdown.querySelector('.dropdown-content');
        
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            // Close other dropdowns
            document.querySelectorAll('.dropdown-content').forEach(otherContent => {
                if (otherContent !== content) {
                    otherContent.style.display = 'none';
                }
            });
            
            // Toggle current dropdown
            if (content.style.display === 'flex') {
                content.style.display = 'none';
            } else {
                content.style.display = 'flex';
            }
        });
    });
    
    // Close dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.dropdown')) {
            document.querySelectorAll('.dropdown-content').forEach(content => {
                content.style.display = 'none';
            });
        }
    });
}

// Initialize dropdowns
document.addEventListener('DOMContentLoaded', setupDropdowns);