import zipfile, re, time
from collections import defaultdict, Counter

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'


def extract_formulas_fast(content):
    """Extract all (cell_ref, formula) pairs using fast batch string operations."""
    results = []
    
    # Strategy: Find all <c r="CELL"> tags and their corresponding </c> tags as blocks.
    # Use a single pass with string find for speed instead of regex per cell.
    
    # First, find positions of all '<c r=' openings and '</c>' closings
    c_open_pattern = '<c r="'
    c_close_tag = '</c>'
    
    pos = 0
    while True:
        start = content.find(c_open_pattern, pos)
        if start == -1:
            break
        
        # Find the cell reference between quotes after 'r="'
        ref_start = start + len('c r="')
        ref_end = content.find('"', ref_start)
        if ref_end == -1:
            pos = start + 1
            continue
        
        cell_ref = content[ref_start:ref_end]
        
        # Find the closing </c> for this cell block
        close_pos = content.find(c_close_tag, start)
        if close_pos == -1:
            pos = start + 1
            continue
        
        block = content[start:close_pos]
        
        # Check if it's a self-closing <c .../> (no </c> because it ends with />)
        if '"/>' in block or "/>" in content[ref_end-2:ref_end+3]:
            pos = close_pos + len(c_close_tag)
            continue
        
        # Now check for <f> tags within this cell block
        f_pattern = '<f>'
        f_start = block.find(f_pattern)
        if f_start == -1:
            pos = close_pos + len(c_close_tag)
            continue
        
        # Find the closing </f> tag
        f_content_start = f_start + len('<f>')
        f_end_tag = '</f>'
        f_end_search = block.find(f_end_tag, f_content_start)
        if f_end_search == -1:
            pos = close_pos + len(c_close_tag)
            continue
        
        formula_text = block[f_content_start:f_end_search].strip()
        # Normalize whitespace
        formula_clean = ' '.join(formula_text.split())
        
        if formula_clean:
            results.append((cell_ref, formula_clean))
        
        pos = close_pos + len(c_close_tag)
    
    return results


def parse_col_num(col_str):
    """Convert column letters to number (A=1, B=2, ..., Z=26, AA=27)."""
    n = 0
    for ch in col_str:
        n = n * 26 + (ord(ch) - ord('A') + 1)
    return n


def main():
    t_start = time.time()
    print("Loading XLSX...")
    
    with zipfile.ZipFile(XLSX, 'r') as z:
        wb = z.read('xl/workbook.xml').decode('utf-8')
        
        # Map sheet position -> name (sequential rId order)
        pos_to_name = {}
        for i, m in enumerate(re.finditer(r'<sheet\s+name="([^"]+)"[^>]*r:id="rId(\d+)"', wb)):
            pos_to_name[i + 1] = m.group(1)
        
        # Read all sheets
        results = {}
        total_bytes = 0
        
        for inf in z.infolist():
            if 'worksheets/sheet' not in inf.filename or not inf.filename.endswith('.xml'):
                continue
            
            num = int(re.search(r'sheet(\d+)\.xml', inf.filename).group(1))
            name = pos_to_name.get(num, 'Sheet%d' % num)
            
            content = z.read(inf.filename).decode('utf-8')
            total_bytes += len(content)
            
            # Fast formula extraction
            formulas = extract_formulas_fast(content)
            
            if formulas:
                results[name] = formulas
                elapsed = time.time() - t_start
                print('%s: %d formulas (%.1fs, %dKB xml)' % (name, len(formulas), elapsed, len(content)//1024))
        
        total_formulas = sum(len(f) for f in results.values())
        elapsed = time.time() - t_start
        print('\nTotal: %d formulas across %d sheets (%dMB XML) in %.1fs' % (total_formulas, len(results), total_bytes//1024//1024, elapsed))

    # === ANALYSIS 1: Cross-week positional consistency ===
    weekly_sheets = {}
    for name, formulas in results.items():
        if re.match(r'^W\d+$', name):
            weekly_sheets[name] = formulas
    
    print('\n' + '=' * 70)
    print('ANALYSIS 1: Cross-Week Positional Consistency')
    print('=' * 70)
    
    # Build position map using fast string ops
    pos_map = defaultdict(list)
    for sheet, formulas in weekly_sheets.items():
        for cell_ref, formula in formulas:
            m2 = re.match(r'^([A-Z]+)(\d+)$', cell_ref)
            if m2:
                pos_key = '%s%s' % (m2.group(1), m2.group(2))
                pos_map[pos_key].append((sheet, formula))
    
    anomalies_high = []
    anomalies_med = []
    
    for pos_key in sorted(pos_map.keys()):
        entries = pos_map[pos_key]
        if len(entries) < 2:
            continue
        
        # Group by function signature (just function names)
        func_groups = defaultdict(list)
        for sheet, formula in entries:
            funcs = tuple(re.findall(r'\b([A-Z]{2,10})\(', formula))
            if funcs:
                func_groups[funcs].append((sheet, formula))
        
        if len(func_groups) <= 1:
            continue
        
        group_sizes = {k: len(v) for k, v in func_groups.items()}
        sorted_g = sorted(group_sizes.items(), key=lambda x: -x[1])
        majority_size = sorted_g[0][1]
        total_at_pos = sum(group_sizes.values())
        
        if majority_size >= total_at_pos - 1:
            confidence = 'HIGH'
            anomalies_high.append((pos_key, func_groups))
        else:
            confidence = 'MEDIUM'
            anomalies_med.append((pos_key, func_groups))
    
    print('\nHigh-confidence anomalies (likely copy-paste errors): %d' % len(anomalies_high))
    print('Medium-confidence anomalies: %d\n' % len(anomalies_med))
    
    if anomalies_high:
        print('HIGH confidence details:')
        for pos_key, func_groups in sorted(anomalies_high, key=lambda x: x[0])[:30]:
            groups_dict = {}
            for i, (funcs, elist) in enumerate(func_groups.items()):
                sheets = sorted(elist, key=lambda x: int(re.search(r'(\d+)', x[0]).group()) if re.search(r'(\d+)', x[0]) else 999)
                groups_dict[str(i + 1)] = {
                    'funcs': list(funcs),
                    'count': len(sheets),
                    'sheets': [s[0] for s in sheets],
                    'sample': elist[0][1][:120] if elist else ''
                }
            
            majority_g = max(groups_dict.values(), key=lambda g: g['count'])
            minority_gs = [g for g in groups_dict.values() if g['count'] != majority_g['count']]
            
            print('\n  [%s] position %s' % (majority_g['count'], pos_key))
            print('    Majority (%d sheets): %s' % (majority_g['count'], majority_g['funcs']))
            print('      Sample: %s...' % majority_g['sample'][:100])
            for mg in minority_gs:
                affected = sorted(mg['sheets'], key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                print('    Minority (%d sheet): %s -> %s' % (mg['count'], mg['funcs'], ', '.join(affected[:5])))
                if mg['sample']:
                    print('      Sample: %s...' % mg['sample'][:100])

    # === ANALYSIS 2: Off-by-one range errors ===
    print('\n' + '=' * 70)
    print('ANALYSIS 2: Potential Off-by-One Range Errors')
    print('=' * 70)
    
    pos_ranges = defaultdict(lambda: defaultdict(list))
    for sheet, formulas in weekly_sheets.items():
        for cell_ref, formula in formulas:
            m2 = re.match(r'^([A-Z]+)(\d+)$', cell_ref)
            if not m2:
                continue
            pos_key = '%s%s' % (m2.group(1), m2.group(2))
            
            for rm in re.finditer(r'(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)', formula):
                range_str = '%s:%s' % (rm.group(1), rm.group(2))
                pos_ranges[pos_key][range_str].append(sheet)
    
    ob_anomalies = []
    seen_pairs = set()
    for pos_key, ranges in sorted(pos_ranges.items()):
        if len(ranges) <= 1:
            continue
        rlist = list(ranges.keys())
        for i in range(len(rlist)):
            for j in range(i + 1, len(rlist)):
                r1, r2 = rlist[i], rlist[j]
                s1, e1 = r1.split(':')
                s2, e2 = r2.split(':')
                rs1 = int(re.search(r'(\d+)', s1).group())
                re1 = int(re.search(r'(\d+)', e1).group())
                rs2 = int(re.search(r'(\d+)', s2).group())
                re2 = int(re.search(r'(\d+)', e2).group())
                len1, len2 = re1 - rs1, re2 - rs2
                
                if abs(len1 - len2) == 1:
                    pair = (pos_key, tuple(sorted([r1, r2])))
                    if pair not in seen_pairs:
                        seen_pairs.add(pair)
                        ob_anomalies.append({
                            'pos': pos_key,
                            'r1': r1, 'r2': r2,
                            's1': sorted(set(ranges[r1]), key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999),
                            's2': sorted(set(ranges[r2]), key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                        })
    
    print('\nOff-by-one anomalies: %d' % len(ob_anomalies))
    seen_r = set()
    for a in sorted(ob_anomalies, key=lambda x: x['pos']):
        pair = tuple(sorted([a['r1'], a['r2']]))
        if pair in seen_r:
            continue
        seen_r.add(pair)
        merged_s1 = set()
        merged_s2 = set()
        for x in ob_anomalies:
            xp = tuple(sorted([x['r1'], x['r2']]))
            if xp == pair:
                if x['r1'] == a['r1']:
                    merged_s1.update(x['s1'])
                else:
                    merged_s2.update(x['s2'])
        ms1 = sorted(merged_s1, key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
        ms2 = sorted(merged_s2, key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
        print('  "%s" vs "%s"' % (a['r1'], a['r2']))
        print('    Pattern A (%d sheets): %s' % (len(ms1), ', '.join(ms1[:8])))
        print('    Pattern B (%d sheets): %s' % (len(ms2), ', '.join(ms2[:8])))

    # === ANALYSIS 3: Cross-sheet reference patterns ===
    print('\n' + '=' * 70)
    print('ANALYSIS 3: Cross-Sheet Reference Patterns')
    print('=' * 70)
    
    team_refs = defaultdict(lambda: defaultdict(int))
    for sheet, formulas in weekly_sheets.items():
        for cell_ref, formula in formulas:
            refs = re.findall(r"'([^']*)'!", formula)
            for ref in refs:
                if re.match(r'^T\d+$', ref):
                    team_refs[sheet][ref] += cnt
    
    all_teams = Counter()
    for week, refs in team_refs.items():
        for team, cnt in refs.items():
            all_teams[team] += cnt
    
    print('\nMost referenced teams:')
    for team, count in all_teams.most_common(12):
        ref_count = sum(1 for w, r in team_refs.items() if r.get(team, 0) > 0)
        pct = ref_count / len(weekly_sheets) * 100
        flag = ' ***' if pct < 50 else ''
        print('  %s: referenced in %d/%d weeks (%.0f%%)%s' % (team, ref_count, len(weekly_sheets), pct, flag))

    # === SUMMARY ===
    elapsed = time.time() - t_start
    print('\n' + '=' * 70)
    print('SUMMARY')
    print('=' * 70)
    print('Analysis time: %.1fs' % elapsed)
    print('High-confidence anomalies: %d' % len(anomalies_high))
    print('Medium-confidence anomalies: %d' % len(anomalies_med))
    print('Off-by-one errors: %d' % len(ob_anomalies))


if __name__ == '__main__':
    main()
