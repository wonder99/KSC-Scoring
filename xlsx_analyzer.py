#!/usr/bin/env python3
"""Fast XLSX Formula Inconsistency Analyzer - optimized for large files."""

import zipfile
import re
from collections import defaultdict, Counter

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'


def extract_formulas_fast(content):
    """Extract (cell_ref, formula) pairs using string operations instead of heavy regex."""
    results = []
    # Find all <f> tags directly - much faster than finding cell blocks first
    for m in re.finditer(r'<c\s+r="([A-Z0-9]+)"[^>]*>[^<]*(?:<f>(.*?)</f>)', content):
        cell_ref = m.group(1)
        formula = m.group(2).strip() if m.group(2) else ""
        if formula:
            results.append((cell_ref, formula))
    
    # Also catch cases where <f> tag contains newlines (DOTALL needed)
    for m in re.finditer(r'<c\s+r="([A-Z0-9]+)"[^>]*>(?:(?!</c>).)*?<f>(.*?)</f>', content):
        cell_ref = m.group(1)
        formula = m.group(2).strip().replace('\n', ' ')
        if formula and (cell_ref, formula) not in results:
            results.append((cell_ref, formula))
    
    return results


def parse_col(col_str):
    """Convert column letters to number."""
    result = 0
    for ch in col_str:
        result = result * 26 + (ord(ch) - ord('A') + 1)
    return result


def main():
    print("="*80)
    print("XLSX FORMULA INCONSISTENCY ANALYZER")
    print("="*80)
    
    import time
    t0 = time.time()
    
    with zipfile.ZipFile(XLSX, 'r') as z:
        wb_content = z.read('xl/workbook.xml').decode('utf-8')
        
        # Map position -> name
        pos_to_name = {}
        for i, m in enumerate(re.finditer(r'<sheet\s+name="([^"]+)"[^>]*r:id="rId(\d+)"', wb_content)):
            pos_to_name[i+1] = m.group(1)
        
        print(f"\n  Sheets: {len(pos_to_name)}")
        print(f"  Reading all sheets...")
        
        formulas_by_sheet = {}
        total_cells = 0
        
        # Read all sheet files first (this is the main I/O step)
        sheet_contents = []
        for inf in z.infolist():
            if 'worksheets/sheet' in inf.filename and inf.filename.endswith('.xml'):
                num_match = re.search(r'sheet(\d+)\.xml', inf.filename)
                if num_match:
                    pos_num = int(num_match.group(1))
                    sheet_name = pos_to_name.get(pos_num, f"Sheet{pos_num}")
                    content = z.read(inf.filename).decode('utf-8')
                    sheet_contents.append((sheet_name, content))
        
        print(f"  Processed {len(sheet_contents)} sheets in {time.time()-t0:.1f}s")
        
        # Extract formulas from each sheet
        for name, content in sheet_contents:
            formulas = extract_formulas_fast(content)
            formulas_by_sheet[name] = formulas
            total_cells += len(formulas)
        
        print(f"  Total formulas extracted: {total_cells} in {time.time()-t0:.1f}s")
    
    # Print formula counts per sheet
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
            print(f"    {cell}: {clean[:120]}")
    
    # Analysis 1: Cross-week consistency - the most important check
    print("\n" + "="*80)
    print("ANALYSIS 1: Cross-Week Formula Consistency (W1-W22)")
    print("="*80)
    
    weekly = {k: v for k, v in formulas_by_sheet.items() if re.match(r'^W\d+$', k)}
    print(f"\n  Comparing {len(weekly)} weekly sheets...")
    
    # Build position map: pos_key -> [(sheet, formula)]
    t1 = time.time()
    pos_map = defaultdict(list)
    for sheet_name, formulas in weekly.items():
        for cell_ref, formula in formulas:
            m2 = re.match(r'^([A-Z]+)(\d+)$', cell_ref)
            if m2:
                pos_key = f"{m2.group(1)}{m2.group(2)}"
                pos_map[pos_key].append((sheet_name, formula))
    print(f"  Position map built in {time.time()-t1:.1f}s ({len(pos_map)} unique positions)")
    
    # For each position, check if formulas are consistent across weeks
    anomalies = []
    t2 = time.time()
    
    for pos_key in sorted(pos_map.keys()):
        entries = pos_map[pos_key]
        if len(entries) < 2:
            continue
        
        # Group by function signature (just the function names, ignoring args)
        func_groups = defaultdict(list)
        for sheet, formula in entries:
            funcs = tuple(re.findall(r'\b([A-Z]{2,10})\(', formula))
            if funcs:
                func_groups[funcs].append((sheet, formula))
        
        if len(func_groups) <= 1:
            continue
        
        # Multiple different patterns at this position - anomaly!
        group_sizes = {k: len(v) for k, v in func_groups.items()}
        sorted_g = sorted(group_sizes.items(), key=lambda x: -x[1])
        majority_size = sorted_g[0][1]
        total_sheets_at_pos = sum(group_sizes.values())
        
        # Most likely a copy-paste error if most sheets agree and only 1-2 differ
        if majority_size >= total_sheets_at_pos - 1:
            confidence = 'HIGH'
        else:
            confidence = 'MEDIUM'
        
        anomaly = {
            'position': pos_key,
            'confidence': confidence,
            'total_sheets': total_sheets_at_pos,
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
    
    print(f"  Anomaly detection done in {time.time()-t2:.1f}s")
    
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
                
                print(f"\n  Position {pos} ({anomaly['total_sheets']} sheets have formulas here)")
                print(f"    Majority ({majority_group['count']} sheets):")
                print(f"      Functions: {majority_group['functions']}")
                clean_sample = re.sub(r'\s+', ' ', majority_group['sample']).strip()
                print(f"      Sample: {clean_sample[:120]}...")
                
                if minority_groups:
                    for mg in minority_groups:
                        affected = sorted(mg['sheets'], key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                        print(f"    Minority ({mg['count']} sheet{'s' if mg['count']>1 else ''}):")
                        print(f"      Functions: {mg['functions']}")
                        print(f"      Affected: {', '.join(affected[:5])}")
                        clean_sample2 = re.sub(r'\s+', ' ', mg['sample']).strip()
                        if clean_sample2:
                            print(f"      Sample: {clean_sample2[:120]}...")
    
    # Analysis 2: Off-by-one errors - check ranges that differ by exactly 1
    print("\n" + "="*80)
    print("ANALYSIS 2: Potential Off-by-One Range Errors")
    print("="*80)
    
    t3 = time.time()
    pos_ranges = defaultdict(lambda: defaultdict(list))
    
    for sheet_name, formulas in weekly.items():
        for cell_ref, formula in formulas:
            m2 = re.match(r'^([A-Z]+)(\d+)$', cell_ref)
            if not m2:
                continue
            pos_key = f"{m2.group(1)}{m2.group(2)}"
            
            # Find ranges like A1:A5 or $A$1:$B$3
            for range_match in re.finditer(r'(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)', formula):
                range_str = f"{range_match.group(1)}:{range_match.group(2)}"
                pos_ranges[pos_key][range_str].append(sheet_name)
    
    anomalies2 = []
    seen_pairs = set()
    
    for pos_key, ranges in sorted(pos_ranges.items()):
        if len(ranges) <= 1:
            continue
        
        range_list = list(ranges.keys())
        for i in range(len(range_list)):
            for j in range(i+1, len(range_list)):
                r1, r2 = range_list[i], range_list[j]
                
                # Parse ranges to check if lengths differ by 1
                s1, e1 = r1.split(':')
                s2, e2 = r2.split(':')
                
                row_s1 = int(re.search(r'(\d+)', s1).group())
                row_e1 = int(re.search(r'(\d+)', e1).group())
                row_s2 = int(re.search(r'(\d+)', s2).group())
                row_e2 = int(re.search(r'(\d+)', e2).group())
                
                len1, len2 = row_e1 - row_s1, row_e2 - row_s2
                
                if abs(len1 - len2) == 1:
                    pair_key = (pos_key, tuple(sorted([r1, r2])))
                    if pair_key not in seen_pairs:
                        seen_pairs.add(pair_key)
                        anomalies2.append({
                            'position': pos_key,
                            'range1': r1,
                            'range2': r2,
                            'sheets1': sorted(set(ranges[r1]), key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999),
                            'sheets2': sorted(set(ranges[r2]), key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                        })
    
    if anomalies2:
        print(f"\n  Found {len(anomalies2)} potential off-by-one errors in {time.time()-t3:.1f}s:")
        
        # Merge by range pair to reduce duplicates
        seen_range = set()
        for a in sorted(anomalies2, key=lambda x: x['position']):
            pair_key = tuple(sorted([a['range1'], a['range2']]))
            if pair_key in seen_range:
                continue
            seen_range.add(pair_key)
            
            merged_1 = set()
            merged_2 = set()
            for x in anomalies2:
                xp = tuple(sorted([x['range1'], x['range2']]))
                if xp == pair_key:
                    if x['range1'] == a['range1']:
                        merged_1.update(x['sheets1'])
                    else:
                        merged_2.update(x['sheets2'])
            
            merged_1 = sorted(merged_1, key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
            merged_2 = sorted(merged_2, key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
            
            print(f"\n  '{a['range1']}' vs '{a['range2']}':")
            print(f"    Pattern A ({len(merged_1)} sheets): {', '.join(merged_1[:8])}{'...' if len(merged_1)>8 else ''}")
            print(f"    Pattern B ({len(merged_2)} sheets): {', '.join(merged_2[:8])}{'...' if len(merged_2)>8 else ''}")
    else:
        print(f"\n  No off-by-one errors detected in {time.time()-t3:.1f}s")
    
    # Final summary
    t_end = time.time()
    print("\n" + "="*80)
    print("SUMMARY")
    print("="*80)
    print(f"\n  Total analysis time: {t_end-t0:.1f}s")
    print(f"  Cross-week inconsistencies: {len(anomalies)} (HIGH: {len(high_conf)}, MEDIUM: {len(med_conf)})")
    print(f"  Off-by-one range errors: {len(anomalies2)}")
    
    # Write report
    report_path = r'C:\Users\Paul\Projects\The-701-Club\formula_analysis_report.txt'
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("XLSX FORMULA INCONSISTENCY ANALYSIS REPORT\n")
        f.write("="*80 + f"\nTime: {t_end-t0:.1f}s\n\n")
        
        f.write("FORMULA COUNTS:\n" + "-"*40 + "\n")
        for name, formulas in sorted(formulas_by_sheet.items()):
            if formulas:
                all_funcs = set()
                for _, formula in formulas:
                    all_funcs.update(re.findall(r'\b([A-Z]{2,10})\(', formula))
                f.write(f"\n{name}: {len(formulas)} formulas ({', '.join(sorted(all_funcs)[:8])})")
        
        f.write("\n\nHIGH CONFIDENCE ANOMALIES:\n" + "-"*40 + "\n")
        for anomaly in sorted(high_conf, key=lambda x: x['position']):
            f.write(f"\n[Position {anomaly['position']}] ({anomaly['total_sheets']} sheets)\n")
            for gkey, ginfo in anomaly['groups'].items():
                sheets = sorted(ginfo['sheets'], key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                f.write(f"  Pattern {gkey} ({ginfo['count']} sheets): funcs={ginfo['functions']}\n")
                clean = re.sub(r'\s+', ' ', ginfo.get('sample', '')).strip()
                if clean:
                    f.write(f"    Sample: {clean[:150]}\n")
        
        f.write("\n\nOFF-BY-ONE ANOMALIES:\n" + "-"*40 + "\n")
        seen_range2 = set()
        for a in anomalies2:
            pair_key = tuple(sorted([a['range1'], a['range2']]))
            if pair_key not in seen_range2:
                seen_range2.add(pair_key)
                f.write(f"\nPosition {a['position']}: '{a['range1']}' vs '{a['range2']}'\n")
    
    print(f"\n  Report written to: {report_path}")


if __name__ == '__main__':
    main()
