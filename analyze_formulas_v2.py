import openpyxl
from collections import defaultdict, Counter
import re
import json

print("Loading workbook...")
wb = openpyxl.load_workbook(r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx', data_only=False)

# Focus on weekly sheets W1-W22
weekly_sheets = sorted([ws.title for ws in wb.worksheets if re.match(r'^W\d+$', ws.title)])
team_sheets = [ws.title for ws in wb.worksheets if re.match(r'^T\d+$', ws.title)]
other_sheets = [ws.title for ws in wb.worksheets if ws.title not in weekly_sheets + team_sheets]

print(f"Weekly sheets: {len(weekly_sheets)} -> {weekly_sheets}")
print(f"Team sheets: {team_sheets}")
print(f"Other sheets: {other_sheets}")

# ===== Pass 1: Extract formulas from each weekly sheet, normalize column references =====
# Key insight: Weekly sheets share a layout. Compare formulas positionally across weeks.

def get_cell_key(row, col_letter):
    """Convert cell position to normalized key like 'col_3_row_15'"""
    col_num = 0
    for c in col_letter:
        col_num = col_num * 26 + (ord(c) - ord('A') + 1)
    return f"col_{col_num}_row_{row}"

def normalize_formula(formula, ref_sheet=''):
    """Normalize a formula by replacing sheet-specific references with placeholders"""
    f = formula
    # Remove all cell references to keep it manageable - just track function patterns
    
    # Replace sheet names in cross-references for comparison
    if ref_sheet:
        f = re.sub(r"'[^']*'!", f"<{ref_sheet}>!")
    return f

def extract_func_pattern(formula):
    """Extract the main functions used in a formula"""
    upper = formula.upper()
    funcs = set(re.findall(r'[A-Z_]{2,}(?=\()', upper))
    # Count SUM, AVERAGE, IF, VLOOKUP, etc.
    return sorted(funcs)

print("\n" + "=" * 80)
print("PASS 1: Formula pattern comparison across weekly sheets (W1-W22)")
print("=" * 80)

# For each weekly sheet, extract formulas and their structure
# We'll compare column-by-column to detect copy-paste errors where one cell got the wrong formula
weekly_formulas = {}  # {sheet_name: {(col_idx, row): formula}}

for ws_title in weekly_sheets:
    ws = wb[ws_title]
    print(f"\nProcessing {ws_title}...", end=' ')
    formulas = {}
    for row in ws.iter_rows(min_row=1, max_col=min(ws.max_column, 50), max_row=200):
        for cell in row:
            if cell.value and isinstance(cell.value, str) and cell.value.startswith('='):
                col_idx = cell.column  # numeric column index (1-based)
                formulas[(col_idx, cell.row)] = cell.value
    
    weekly_formulas[ws_title] = formulas
    print(f"{len(formulas)} formulas found")

print("\n" + "=" * 80)
print("PASS 2: Cross-sheet formula comparison - find mismatches")
print("=" * 80)

# Compare every pair of weeks at matching cells - what should be identical often isn't
all_cell_positions = set()
for formulas in weekly_formulas.values():
    all_cell_positions.update(formulas.keys())

positions = sorted(all_cell_positions)
print(f"\nTotal unique (col, row) positions with formulas across any week: {len(positions)}")

# Group by row and column to find positional patterns
mismatches = []  # List of (row, col, sheets_with_different_formulas)

for pos in positions:
    col_idx, row = pos
    
    # Get formulas at this position for each week
    col_letters = ''
    c = col_idx + 1
    while c > 0:
        c, r = divmod(c - 1, 26)
        col_letters = chr(65 + r) + col_letters
    
    sheet_formulas = []
    for ws_title in weekly_sheets:
        if pos in weekly_formulas[ws_title]:
            f = weekly_formulas[ws_title][pos]
            # Normalize: get the core function pattern and argument structure
            funcs = extract_func_pattern(f)
            # Check if it references a specific sheet or has hardcoded values
            has_sheet_ref = bool(re.search(r"'[^']+'!", f))
            
            # Extract just the outermost function and its arguments
            inner_match = re.match(r'^=(\w+)\((.*)\)$', f.strip(), re.DOTALL)
            core = inner_match.group(1).lower() if inner_match else f[:40]
            
            sheet_formulas.append({
                'sheet': ws_title,
                'formula': f[:100],
                'core_func': core,
                'has_sheet_ref': has_sheet_ref,
                'funcs': funcs,
            })
    
    # Compare formulas across sheets at same position - if they should be the same pattern...
    cores = set(s['core_func'] for s in sheet_formulas)
    all_funcs_lists = [tuple(s['funcs']) for s in sheet_formulas]
    
    if len(cores) > 1:
        # Different functions at same position - this might be intentional or a copy-paste error
        pass

print("Analysis of formula patterns by row:")

# Better approach: Look at which functions appear in each ROW across all weeks
# and see if patterns are consistent
for row in sorted(set(pos[1] for pos in positions)):
    col_func_patterns = defaultdict(list)  # {col_idx: set of function names}
    
    for ws_title in weekly_sheets:
        if (None, row) not in [(p[0], p[1]) for p in positions]:
            continue
    
    print(f"\n--- Row {row} ---")

print("DONE")
