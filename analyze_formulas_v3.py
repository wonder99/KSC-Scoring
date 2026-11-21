import zipfile, re, json
from collections import defaultdict, Counter

xlsx_path = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

sheet_names_order = [
    'W22','W21','W20','W19','W18','W17','W16','W15','W14','W13',
    'W12','W11','W10','W9','W8','W7','W6','W5','W4','W3','W2',
    'W1 - Team Master',
    'T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12',
    'Leaders','Mens Overall','Mens Outs','Mens Avg','Mens 95',
    'Lady Overall','Lady Outs','Lady Avg','Lady 95',
    'Standings','Playoff Standings','ScoreSheet'
]

def extract_formulas(xml_content):
    """Extract all formulas from a sheet XML as (row, col_num, formula_text)"""
    formulas = []
    cell_blocks = re.findall(r'<c\s+r="([^"]*)">(.*?)</c>', xml_content, re.DOTALL)
    
    for cell_ref, block in cell_blocks:
        col_match = re.match(r'([A-Z]+)', cell_ref)
        row_match = re.search(r'(\d+)$', cell_ref)
        if not col_match or not row_match:
            continue
        
        col_str = col_match.group(1)
        row_num = int(row_match.group(1))
        col_num = sum((ord(c) - ord('A') + 1) * (26 ** i) for i, c in enumerate(reversed(col_str)))
        
        f_match = re.search(r'<f>(.*?)</f>', block, re.DOTALL)
        if f_match:
            formula = f_match.group(1).strip()
            formulas.append((row_num, col_num, formula))
    
    return formulas

def get_outer_func(formula):
    """Get the outermost function name from a formula"""
    upper = formula.upper().strip()
    m = re.match(r'=(\w+)\(', upper)
    if m:
        return m.group(1).upper()
    # Check for nested functions - find the first opening paren
    paren_pos = upper.find('(')
    if paren_pos > 0:
        before_paren = upper[:paren_pos].strip()
        parts = before_paren.split('.')
        return parts[-1].upper()
    return 'VALUE'

def normalize_formula(formula):
    """Normalize a formula for comparison - replace sheet refs but keep structure"""
    f = formula
    # Replace specific sheet names with generic placeholders
    f = re.sub(r"'([A-Z0-9]+)'!", "<sheet>\1</sheet>!")
    return f

print("=" * 80)
print("FORMULA ANALYSIS: Looking for copy-paste errors in dart league spreadsheet")
print("=" * 80)

with zipfile.ZipFile(xlsx_path, 'r') as zf:
    xml_files = sorted([n for n in zf.namelist() if 'worksheets/sheet' in n.lower() and n.endswith('.xml')])
    print(f"\nFound {len(xml_files)} sheet XML files")

# Extract formulas from weekly sheets W1-W22
weekly_data = {}  # {sheet_name: {(row, col): formula}}

print("\nExtracting formulas from weekly sheets...")
for idx, sheet_name in enumerate(['W22','W21','W20','W19','W18','W17','W16','W15','W14','W13',
                                   'W12','W11','W10','W9','W8','W7','W6','W5','W4','W3','W2','W1 - Team Master']):
    if idx >= len(xml_files):
        continue
    
    content = zf.read(xml_files[idx]).decode('utf-8', errors='replace')
    formulas = extract_formulas(content)
    
    # Store by position for easier comparison
    weekly_data[sheet_name] = {}
    for row, col, formula in formulas:
        weekly_data[sheet_name][(row, col)] = formula
    
    print(f"  {sheet_name}: {len(formulas)} formulas")

# Analysis 1: Function type distribution per sheet
print("\n" + "=" * 80)
print("ANALYSIS 1: Formula function types per weekly sheet")
print("=" * 80)

func_dist = {}
for name, pos_formulas in weekly_data.items():
    func_counts = Counter()
    for (row, col), formula in pos_formulas.items():
        func = get_outer_func(formula)
        func_counts[func] += 1
    func_dist[name] = func_counts

# Show function distribution for each week
for name in sorted(func_dist.keys()):
    funcs = func_dist[name].most_common(10)
    total = sum(funcs[k][1] for k in range(len(funcs))) if funcs else 0
    print(f"\n{name} (total: {len(funcs)} unique functions):")
    for func, count in funcs[:10]:
        bar = '#' * min(count, 50)
        print(f"  {func:20s} {count:>4d}  {bar}")

# Analysis 2: Cross-week comparison of formula patterns by row
print("\n" + "=" * 80)
print("ANALYSIS 2: Row-by-row function consistency across weeks")
print("=" * 80)

# For each row, check if the dominant function is consistent across all weeks
all_rows = set()
for name in weekly_data:
    for (row, col) in weekly_data[name]:
        all_rows.add(row)

row_anomalies = {}  # {row: {sheet_name: set of functions}}

print("\nLooking for rows with inconsistent function patterns...")
for row in sorted(all_rows):
    week_funcs = {}
    for name in weekly_data:
        funcs_at_row = set()
        for (r, c), formula in weekly_data[name].items():
            if r == row:
                func = get_outer_func(formula)
                funcs_at_row.add(func)
        if funcs_at_row:
            week_funcs[name] = tuple(sorted(funcs_at_row))
    
    # Check consistency across weeks
    unique_patterns = set(week_funcs.values())
    
    if len(unique_patterns) > 1:
        # Find the dominant pattern (most common)
        pattern_counts = Counter(week_funcs.values())
        dominant = pattern_counts.most_common(1)[0]
        dominant_pattern = dominant[0]
        dominant_count = dominant[1]
        
        # Find outliers
        outliers = {}
        for name, funcs in week_funcs.items():
            if funcs != dominant_pattern:
                outliers[name] = funcs
        
        if len(outliers) > 0:
            row_anomalies[row] = {
                'dominant': dominant_pattern,
                'dominant_count': dominant_count,
                'outliers': outliers,
                'unique_patterns': len(unique_patterns)
            }

if row_anomalies:
    print(f"\nFound {len(row_anomalies)} rows with function pattern inconsistencies:")
    
    # Group anomalies by type
    anomaly_types = defaultdict(list)
    for row, data in row_anomalies.items():
        anomaly_types[data['dominant'][0]].append((row, data))
    
    print("\nGrouped by dominant function:")
    for func, rows in sorted(anomaly_types.items(), key=lambda x: -len(x[1]))[:20]:
        print(f"\n  {func} dominant in {len(rows)} rows:")
        # Show sample outliers
        for row, data in rows[:5]:
            outlier_strs = []
            for sname, funcs in data['outliers'].items():
                outlier_strs.append(f"{sname}:{','.join(funcs)}")
            print(f"    Row {row:>3d}: dominant={','.join(data['dominant'])} "
                  f"(count={data['dominant_count']}), outliers={', '.join(outlier_strs)}")
else:
    print("\nNo row-level function pattern anomalies found.")

# Analysis 3: Same-position comparison across weeks (deeper check)
print("\n" + "=" * 80)
print("ANALYSIS 3: Same-position formula comparison across all weeks")
print("=" * 80)

# For each (row, col) position shared by most weeks, compare the normalized formulas
# Look for positions where one sheet has a noticeably different formula than others
position_anomalies = []
all_positions = set()
for name in weekly_data:
    all_positions.update(weekly_data[name].keys())

print(f"\nComparing {len(all_positions)} unique positions across weeks...")

for pos in sorted(all_positions):
    row, col = pos
    
    # Get the normalized formula pattern for each sheet at this position
    pos_formulas = {}
    for name in weekly_data:
        if pos in weekly_data[name]:
            formula = weekly_data[name][pos]
            norm = normalize_formula(formula)
            func = get_outer_func(formula)
            # Extract just the function arguments part (after outer parens)
            args_match = re.match(r'=(\w+)\((.*)\)$', formula, re.DOTALL)
            if args_match:
                pos_formulas[name] = {
                    'func': func,
                    'norm': norm[:150],  # truncated for comparison
                    'raw': formula[:200]
                }
    
    # If this position exists in most weeks (>= 80%), compare them
    if len(pos_formulas) >= len(weekly_data) * 0.8:
        unique_funcs = set(f['func'] for f in pos_formulas.values())
        
        if len(unique_funcs) > 1:
            # Different functions - check if it's a clear anomaly
            func_counts = Counter(f['func'] for f in pos_formulas.values())
            dominant = func_counts.most_common(1)[0]
            
            if dominant[1] >= len(pos_formulas) * 0.7:
                outliers = [(name, f) for name, f in pos_formulas.items() 
                           if f['func'] != dominant[0]]
                
                if outliers:
                    # Check if the anomaly formula looks like a copy-paste error
                    outlier_strs = []
                    for sname, fdata in outliers:
                        outlier_strs.append(f"{sname}: {fdata['func']}({fdata['norm'][:60]})")
                    
                    position_anomalies.append({
                        'row': row,
                        'col': col,
                        'dominant_func': dominant[0],
                        'dominant_count': dominant[1],
                        'outliers': outlier_strs
                    })

if position_anomalies:
    print(f"\nFound {len(position_anomalies)} positions with formula anomalies:")
    
    # Show by function type
    anomaly_by_func = defaultdict(list)
    for a in position_anomalies:
        anomaly_by_func[a['dominant_func']].append(a)
    
    for func, anomalies in sorted(anomaly_by_func.items(), key=lambda x: -len(x[1]))[:20]:
        print(f"\n  Dominant function: {func} ({len(anomalies)} anomalies)")
        for a in anomalies[:5]:
            col_letter = ''
            c = a['col'] + 1
            while c > 0:
                c, r = divmod(c - 1, 26)
                col_letter = chr(65 + r) + col_letter
            
            print(f"    Row {a['row']:>3d}, Col {col_letter}:")
            for s in a['outliers'][:3]:
                print(f"      {s}")
else:
    print("\nNo significant cross-week formula position anomalies found.")

# Analysis 4: Look for specific copy-paste error patterns
print("\n" + "=" * 80)
print("ANALYSIS 4: Specific copy-paste error detection")
print("=" * 80)

common_errors = []

for name in sorted(weekly_data.keys()):
    sheet_issues = []
    
    for (row, col), formula in weekly_data[name].items():
        issues = []
        
        # Check 1: Hardcoded row numbers that should be relative
        if re.search(r'\$[0-9]+\$', formula):
            abs_rows = len(re.findall(r'\$\d+\$', formula))
            if abs_rows > 2:
                issues.append(f'Hardcoded absolute rows: {abs_rows}')
        
        # Check 2: Sheet references to wrong week sheets
        sheet_refs = re.findall(r"'([^']*!)'", formula)
        for ref in sheet_refs:
            if ref.upper().startswith('W') and ref not in name.upper():
                # Cross-week reference - might be copy-paste error if it's in weekly context
                issues.append(f'Cross-sheet ref to {ref}')
        
        # Check 3: AVERAGE with hardcoded range that should be dynamic
        avgs = re.findall(r'AVERAGE\s*\(([^)]+)\)', formula, re.IGNORECASE)
        for avg_range in avgs:
            if '$$' in avg_range or (re.search(r'\$\d\$\d', avg_range) and not re.search(r'\$[A-Z]\$\d', avg_range)):
                issues.append(f'AVERAGE with unusual range: {avg_range[:60]}')
        
        # Check 4: VLOOKUP looking in first column when data is in other columns
        vlookups = re.findall(r'VLOOKUP\s*\(([^,]+),\s*([^,]+),\s*(\d+)', formula, re.IGNORECASE)
        for lookup_val, lookup_range, col_idx in vlookups:
            try:
                col_num = int(col_idx)
                if col_num == 1 and 'VLOOKUP' in formula.upper():
                    # Looking up in column 1 - might be wrong if data starts elsewhere
                    pass
            except ValueError:
                pass
        
        # Check 5: IF with hardcoded numbers that should reference cells
        ifs = re.findall(r'IF\s*\(([^,]+),\s*([^,]+),\s*([^)]+)\)', formula, re.IGNORECASE)
        for cond, true_val, false_val in ifs:
            if re.search(r'[0-9]{4}', cond):
                # Hardcoded year - might be copy-paste error if it should reference a cell
                pass
        
        if issues:
            sheet_issues.append({
                'row': row,
                'col': col,
                'formula': formula[:120],
                'issues': issues
            })
    
    if sheet_issues:
        common_errors.append({
            'sheet': name,
            'issue_count': len(sheet_issues),
            'sample': sheet_issues[:3]  # First 3 issues
        })

if common_errors:
    print(f"\nFound {len(common_errors)} sheets with potential copy-paste issues:")
    
    for err in sorted(common_errors, key=lambda x: -x['issue_count']):
        if err['issue_count'] > 0:
            print(f"\n  {err['sheet']}: {err['issue_count']} issues")
            for sample in err['sample']:
                col_letter = ''
                c = sample['col'] + 1
                while c > 0:
                    c, r = divmod(c - 1, 26)
                    col_letter = chr(65 + r) + col_letter
                
                print(f"    Row {sample['row']:>3d}, Col {col_letter}:")
                print(f"      Formula: {sample['formula'][:80]}")
                for issue in sample['issues']:
                    print(f"      Issue: {issue}")
else:
    print("\nNo specific copy-paste error patterns found.")

# Summary
print("\n\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"\nTotal weekly sheets analyzed: {len(weekly_data)}")
print(f"Total positions across all weeks: {len(all_positions)}")
print(f"Row-level inconsistencies found: {len(row_anomalies)}")
print(f"Position-level anomalies found: {len(position_anomalies)}")
print(f"Sheets with potential copy-paste issues: {len(common_errors)}")

if row_anomalies or position_anomalies or common_errors:
    print("\n" + "=" * 80)
    print("RECOMMENDATION: Focus manual review on these areas:")
    print("=" * 80)
    
    if position_anomalies:
        print("\n1. Formula anomalies at same positions across weeks:")
        for a in position_anomalies[:10]:
            col_letter = ''
            c = a['col'] + 1
            while c > 0:
                c, r = divmod(c - 1, 26)
                col_letter = chr(65 + r) + col_letter
            print(f"   Row {a['row']:>3d}, Col {col_letter}: "
                  f"{a['dominant_func']} vs anomalies: {'; '.join(a['outliers'][:2])}")

print("\nAnalysis complete.")
