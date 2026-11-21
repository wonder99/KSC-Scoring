#!/usr/bin/env python3
"""
XLSX Formula Inconsistency Analyzer - Detects copy-paste errors.

Compares formulas at same positions across sheets to find anomalies.
Uses raw XML parsing for speed on 40MB+ files.
"""

import zipfile
import re
from collections import defaultdict, Counter

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'


def extract_formula_cells(sheet_xml):
    """Extract (cell_ref, formula_text) from sheet XML content."""
    results = []
    cell_pattern = re.compile(r'<c\s+r="([A-Z0-9]+)"[^>]*/?>')
    
    for cell_match in cell_pattern.finditer(sheet_xml):
        cell_ref = cell_match.group(1)
        start = cell_match.start()
        end = sheet_xml.find('</c>', start)
        if end == -1:
            end = start + 5000
        
        cell_content = sheet_xml[start:end]
        f_match = re.search(r'<f>(.*?)</f>', cell_content, re.DOTALL)
        if f_match:
            formula = re.sub(r'\s+', ' ', f_match.group(1).strip())
            if formula:
                results.append((cell_ref, formula))
    
    return results


def parse_cell_ref(ref):
    """Parse 'A1' -> (col_letters, row_num, col_number)."""
    m = re.match(r'^([A-Z]+)(\d+)$', ref)
    if not m:
        return None, None, None
    col_str, row_num = m.group(1), int(m.group(2))
    col_num = sum((ord(c) - ord('A') + 1) * (26 ** i) for i, c in enumerate(reversed(col_str)))
    return col_str, row_num, col_num


def get_position_key(ref):
    """Get normalized position key from cell reference."""
    col_str, row_num, _ = parse_cell_ref(ref)
    if col_str and row_num:
        return f"{col_str}{row_num}"
    return None


def extract_sheet_references(formula):
    """Extract sheet names referenced in formula."""
    refs = re.findall(r"'([^']*)'!", formula)
    return list(set(refs)) if refs else []


def analyze_cross_week_consistency(formulas_by_sheet):
    """Compare formulas at same positions across W1-W22 sheets."""
    weekly = {k: v for k, v in formulas_by_sheet.items() if re.match(r'^W\d+$', k)}
    
    print(f"\n{'='*80}")
    print("ANALYSIS 1: Cross-Week Positional Consistency")
    print(f"{'='*80}")
    print(f"Comparing {len(weekly)} weekly sheets...")
    
    # Build position map
    pos_map = defaultdict(list)
    for sheet_name, formulas in weekly.items():
        for cell_ref, formula in formulas:
            pos_key = get_position_key(cell_ref)
            if pos_key:
                pos_map[pos_key].append((sheet_name, formula))
    
    anomalies = []
    
    for pos_key, entries in sorted(pos_map.items()):
        if len(entries) < 2:
            continue
        
        # Group by function signature
        func_groups = defaultdict(list)
        for sheet, formula in entries:
            funcs = tuple(re.findall(r'\b([A-Z]{2,10})\(', formula))
            if funcs:
                func_groups[funcs].append((sheet, formula))
        
        if len(func_groups) <= 1:
            continue
        
        group_sizes = {k: len(v) for k, v in func_groups.items()}
        sorted_groups = sorted(group_sizes.items(), key=lambda x: -x[1])
        majority_size = sorted_groups[0][1]
        total_sheets = sum(group_sizes.values())
        
        if majority_size < total_sheets - 1:
            confidence = 'MEDIUM'
        else:
            confidence = 'HIGH'
        
        anomaly = {
            'position': pos_key,
            'confidence': confidence,
            'groups': {}
        }
        
        for i, (funcs, entries_list) in enumerate(func_groups.items()):
            sheets = sorted(entries_list, key=lambda x: int(re.search(r'(\d+)', x[0]).group()) if re.search(r'(\d+)', x[0]) else 999)
            anomaly['groups'][str(i+1)] = {
                'functions': list(funcs),
                'count': len(sheets),
                'sheets': [s[0] for s in sheets],
                'sample': re.sub(r'\s+', ' ', entries_list[0][1].strip()).strip() if entries_list else ""
            }
        
        anomalies.append(anomaly)
    
    high_conf = [a for a in anomalies if a['confidence'] == 'HIGH']
    med_conf = [a for a in anomalies if a['confidence'] == 'MEDIUM']
    
    if anomalies:
        print(f"\n  Found {len(anomalies)} positions with inconsistent formulas:")
        print(f"    HIGH confidence (likely errors): {len(high_conf)}")
        print(f"    MEDIUM confidence (investigate): {len(med_conf)}")
        
        if high_conf:
            print("\n" + "-"*80)
            print("  HIGH CONFIDENCE ANOMALIES:")
            print("-"*80)
            
            for anomaly in sorted(high_conf, key=lambda x: x['position']):
                pos = anomaly['position']
                groups = anomaly['groups']
                majority_group = max(groups.values(), key=lambda g: g['count'])
                minority_groups = [g for g in groups.values() if g['count'] != majority_group['count']]
                
                print(f"\n  Position {pos}")
                print(f"    Majority ({majority_group['count']} sheets):")
                print(f"      Functions: {majority_group['functions']}")
                clean_sample = re.sub(r'\s+', ' ', majority_group['sample']).strip()
                print(f"      Sample: {clean_sample[:100]}...")
                
                if minority_groups:
                    for mg in minority_groups:
                        affected = sorted(mg['sheets'], key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                        print(f"    Minority ({mg['count']} sheet{'s' if mg['count']>1 else ''}):")
                        print(f"      Functions: {mg['functions']}")
                        print(f"      Affected: {', '.join(affected[:5])}")
                        clean_sample2 = re.sub(r'\s+', ' ', mg['sample']).strip()
                        if clean_sample2:
                            print(f"      Sample: {clean_sample2[:100]}...")
    
    return anomalies


def detect_off_by_one(formulas_by_sheet):
    """Detect range references that differ by exactly 1 cell."""
    weekly = {k: v for k, v in formulas_by_sheet.items() if re.match(r'^W\d+$', k)}
    
    print(f"\n{'='*80}")
    print("ANALYSIS 2: Potential Off-by-One Reference Errors")
    print(f"{'='*80}")
    
    pos_ranges = defaultdict(list)
    for sheet_name, formulas in weekly.items():
        for cell_ref, formula in formulas:
            pos_key = get_position_key(cell_ref)
            if not pos_key:
                continue
            
            ranges = re.findall(r'(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)', formula)
            for start_ref, end_ref in ranges:
                pos_ranges[(pos_key, f"{start_ref}:{end_ref}")].append(sheet_name)
    
    # Find positions where ranges differ
    anomaly_map = defaultdict(lambda: defaultdict(list))
    for (pos, range_str), sheets in pos_ranges.items():
        anomaly_map[pos][range_str] = sorted(set(sheets))
    
    anomalies = []
    seen_pairs = set()
    
    for pos_key, ranges in anomaly_map.items():
        if len(ranges) <= 1:
            continue
        
        range_list = list(ranges.keys())
        for i in range(len(range_list)):
            for j in range(i+1, len(range_list)):
                r1, r2 = range_list[i], range_list[j]
                s1, e1 = r1.split(':')
                s2, e2 = r2.split(':')
                
                _, row_s1 = parse_cell_ref(s1)
                _, row_e1 = parse_cell_ref(e1)
                _, row_s2 = parse_cell_ref(s2)
                _, row_e2 = parse_cell_ref(e2)
                
                len1, len2 = row_e1 - row_s1, row_e2 - row_s2
                
                if abs(len1 - len2) == 1:
                    pair_key = (pos_key, tuple(sorted([r1, r2])))
                    if pair_key not in seen_pairs:
                        seen_pairs.add(pair_key)
                        anomalies.append({
                            'position': pos_key,
                            'range1': r1,
                            'range2': r2,
                            'sheets1': ranges[r1],
                            'sheets2': ranges[r2]
                        })
    
    if anomalies:
        print(f"\n  Found {len(anomalies)} potential off-by-one errors:")
        for a in sorted(anomalies, key=lambda x: x['position']):
            merged_sheets_1 = sorted(set(a['sheets1']), key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
            merged_sheets_2 = sorted(set(a['sheets2']), key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
            
            same_position_anomalies = [x for x in anomalies if (x['range1'], x['range2']) == (a['range1'], a['range2']) or (x['range1'], x['range2']) == (a['range2'], a['range1'])]
            all_positions = sorted(set(x['position'] for x in same_position_anomalies))
            
            print(f"\n  Range '{a['range1']}' vs '{a['range2']}' at positions {', '.join(all_positions)}")
            print(f"    Pattern A ({len(merged_sheets_1)} sheets): {', '.join(merged_sheets_1[:8])}{'...' if len(merged_sheets_1)>8 else ''}")
            print(f"    Pattern B ({len(merged_sheets_2)} sheets): {', '.join(merged_sheets_2[:8])}{'...' if len(merged_sheets_2)>8 else ''}")
    
    return anomalies


def check_reference_patterns(formulas_by_sheet):
    """Check which sheets are referenced by weekly sheets."""
    weekly = {k: v for k, v in formulas_by_sheet.items() if re.match(r'^W\d+$', k)}
    
    print(f"\n{'='*80}")
    print("ANALYSIS 3: Cross-Sheet Reference Patterns")
    print(f"{'='*80}")
    
    team_refs = defaultdict(lambda: defaultdict(int))
    for sheet_name, formulas in weekly.items():
        for cell_ref, formula in formulas:
            refs = extract_sheet_references(formula)
            for ref in refs:
                team_refs[sheet_name][ref] += 1
    
    all_referenced = Counter()
    for week, refs in team_refs.items():
        for target, count in refs.items():
            all_referenced[target] += counting
    
    print(f"\n  Most frequently referenced target sheets:")
    for target, count in all_referenced.most_common(15):
        referencing = sum(1 for w, refs in team_refs.items() if refs.get(target, 0) > 0)
        pct = referencing / len(weekly) * 100
        marker = " <<<" if pct < 50 else ""
        print(f"    {target:30s}: {referencing}/{len(weekly)} weekly sheets ({pct:.0f}%){marker}")
    
    print(f"\n  Target sheets referenced by <50% of weekly sheets:")
    for target, count in all_referenced.items():
        pct = count / len(weekly) * 100
        if pct < 50 and count > 0:
            missing_from = sorted([w for w, refs in team_refs.items() if refs.get(target, 0) == 0], 
                                  key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
            print(f"    {target} ({pct:.0f}%): missing from {', '.join(missing_from[:5])}{'...' if len(missing_from)>5 else ''}")


def analyze_team_sheets(formulas_by_sheet):
    """Compare formulas across team sheets (T1-T12)."""
    teams = {k: v for k, v in formulas_by_sheet.items() if re.match(r'^T\d+$', k)}
    
    print(f"\n{'='*80}")
    print("ANALYSIS 4: Team Sheet Consistency (T1-T12)")
    print(f"{'='*80}")
    
    pos_map = defaultdict(list)
    for sheet_name, formulas in teams.items():
        for cell_ref, formula in formulas:
            pos_key = get_position_key(cell_ref)
            if pos_key:
                pos_map[pos_key].append((sheet_name, formula))
    
    high_conf = 0
    total_inconsistent = 0
    
    for pos_key, entries in sorted(pos_map.items()):
        if len(entries) < len(teams) - 2:
            continue
        
        func_groups = defaultdict(list)
        for sheet, formula in entries:
            funcs = tuple(re.findall(r'\b([A-Z]{2,10})\(', formula))
            if funcs:
                func_groups[funcs].append((sheet, formula))
        
        if len(func_groups) <= 1:
            continue
        
        group_sizes = {k: len(v) for k, v in func_groups.items()}
        majority_size = max(group_sizes.values())
        total = sum(group_sizes.values())
        
        if majority_size < total - 2:
            continue
        
        total_inconsistent += 1
        if majority_size == total - 1:
            high_conf += 1
    
    print(f"\n  Position inconsistencies across {len(teams)} team sheets:")
    print(f"    HIGH confidence (likely errors): {high_conf}")
    print(f"    Total inconsistent positions:    {total_inconsistent}")


def run_analysis():
    """Main entry point."""
    print("="*80)
    print("XLSX FORMULA INCONSISTENCY ANALYZER")
    print("="*80)
    
    with zipfile.ZipFile(XLSX, 'r') as z:
        wb_content = z.read('xl/workbook.xml').decode('utf-8')
        
        pattern = re.compile(r'<sheet\s+name="([^"]+)"[^>]*r:id="(rId\d+)"', re.IGNORECASE)
        rmatches = list(pattern.finditer(wb_content))
        
        pos_to_name = {i+1: m.group(1) for i, m in enumerate(rmatches)}
        
        print(f"\n  Loaded workbook with {len(pos_to_name)} sheets")
        print(f"  Extracting formulas...")
        
        formulas_by_sheet = {}
        for inf in z.infolist():
            if not ('worksheets/sheet' in inf.filename and inf.filename.endswith('.xml')):
                continue
            
            num_match = re.search(r'sheet(\d+)\.xml', inf.filename)
            if not num_match:
                continue
            pos_num = int(num_match.group(1))
            sheet_name = pos_to_name.get(pos_num, f"Sheet{pos_num}")
            
            content = z.read(inf.filename).decode('utf-8')
            formulas_by_sheet[sheet_name] = extract_formula_cells(content)
        
        total = sum(len(f) for f in formulas_by_sheet.values())
        print(f"\n  Total: {total} formulas across {len(formulas_by_sheet)} sheets")
    
    # Show per-sheet counts
    print("\n" + "-"*80)
    print("FORMULA COUNTS PER SHEET")
    print("-"*80)
    for name, formulas in sorted(formulas_by_sheet.items()):
        if not formulas:
            continue
        all_funcs = set()
        for _, formula in formulas:
            all_funcs.update(re.findall(r'\b([A-Z]{2,10})\(', formula))
        print(f"\n  {name}: {len(formulas)} formulas")
        if all_funcs:
            top_funcs = sorted(all_funcs, key=lambda f: -sum(1 for _, f2 in formulas if re.search(r'\b' + f + r'\(', f2)))[:5]
            print(f"    Top functions: {', '.join(top_funcs)}")
        samples = sorted(formulas[:3], key=lambda x: x[0])
        for cell, formula in samples:
            clean = re.sub(r'\s+', ' ', formula).strip()
            print(f"    {cell}: {clean[:100]}")
    
    # Run analyses
    cross_week_anomalies = analyze_cross_week_consistency(formulas_by_sheet)
    off_by_one_anomalies = detect_off_by_one(formulas_by_sheet)
    check_reference_patterns(formulas_by_sheet)
    analyze_team_sheets(formulas_by_sheet)
    
    # Summary
    print(f"\n{'='*80}")
    print("FINAL SUMMARY")
    print(f"{'='*80}")
    
    high_count = sum(1 for a in cross_week_anomalies if a.get('confidence') == 'HIGH')
    med_count = sum(1 for a in cross_week_anomalies if a.get('confidence') == 'MEDIUM')
    
    print(f"\n  Cross-week inconsistencies: {len(cross_week_anomalies)}")
    print(f"    HIGH confidence (likely errors):   {high_count}")
    print(f"    MEDIUM confidence (investigate):   {med_count}")
    print(f"  Off-by-one range errors:             {len(off_by_one_anomalies)}")
    
    # Write detailed report
    report_path = r'C:\Users\Paul\Projects\The-701-Club\formula_analysis_report.txt'
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("XLSX FORMULA INCONSISTENCY ANALYSIS REPORT\n")
        f.write("="*80 + "\n\n")
        
        f.write("FORMULA COUNTS:\n" + "-"*40 + "\n")
        for name, formulas in sorted(formulas_by_sheet.items()):
            if formulas:
                all_funcs = set()
                for _, formula in formulas:
                    all_funcs.update(re.findall(r'\b([A-Z]{2,10})\(', formula))
                f.write(f"\n{name}: {len(formulas)} formulas ({', '.join(sorted(all_funcs)[:8])})")
        
        f.write("\n\nCROSS-WEEK ANOMALIES:\n" + "-"*40 + "\n")
        for anomaly in sorted(cross_week_anomalies, key=lambda x: x['position']):
            if anomaly.get('confidence') == 'HIGH':
                f.write(f"\n[HIGH] Position {anomaly['position']}\n")
                for gkey, ginfo in anomaly['groups'].items():
                    sheets = sorted(ginfo['sheets'], key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                    f.write(f"  Pattern {gkey} ({ginfo['count']} sheets): funcs={ginfo['functions']}\n")
                    clean = re.sub(r'\s+', ' ', ginfo.get('sample', '')).strip()
                    f.write(f"    Sheets: {', '.join(sheets[:5])}\n")
                    if clean:
                        f.write(f"    Sample: {clean[:120]}\n")
        
        f.write("\n\nOFF-BY-ONE ANOMALIES:\n" + "-"*40 + "\n")
        for a in sorted(off_by_one_anomalies, key=lambda x: x['position']):
            f.write(f"\nPosition {a['position']}: '{a['range1']}' vs '{a['range2']}'\n")
            f.write(f"  Pattern A ({len(a['sheets1'])} sheets): {', '.join(a['sheets1'][:5])}\n")
            f.write(f"  Pattern B ({len(a['sheets2'])} sheets): {', '.join(a['sheets2'][:5])}\n")
    
    print(f"\n  Detailed report: {report_path}")


if __name__ == '__main__':
    run_analysis()
