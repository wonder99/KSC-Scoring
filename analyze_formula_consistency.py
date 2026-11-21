"""
Comprehensive formula consistency analysis for Darts Stats XLSX.
Compares formulas at the same cell positions across all W1-W22 weekly sheets
to detect copy-paste errors, off-by-one range bugs, and inconsistent cross-sheet refs.
"""

import openpyxl
from collections import defaultdict, Counter
import re
import sys
import time

XLSX_PATH = r"C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx"

# ---------------------------------------------------------------------------
# Data collection
# ---------------------------------------------------------------------------

def collect_formulas(path):
    """Return dict: {sheet_name: {cell_addr: formula}} for every cell with a formula."""
    wb = openpyxl.load_workbook(path, read_only=True, keep_links=False)
    result = {}
    ws_names = wb.sheetnames  # preserve order
    for name in ws_names:
        ws = wb[name]
        formulas = {}
        for row in ws.iter_rows():
            for cell in row:
                if cell.value and isinstance(cell.value, str) and cell.value.startswith("="):
                    # Normalize whitespace inside the formula (collapse runs of spaces)
                    f = re.sub(r'\s+', ' ', cell.value.strip())
                    formulas[cell.coordinate] = f
        result[name] = formulas
    wb.close()
    return result, ws_names


# ---------------------------------------------------------------------------
# Analysis helpers
# ---------------------------------------------------------------------------

def normalise_range(formula):
    """Replace numeric ranges with a canonical form for comparison.
       e.g. 'A1:A7' -> 'RANGE_INT', '$T$5:$T$7' -> 'RANGE_INT'"""
    return re.sub(r'\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+', 'RANGE_INT', formula)


def extract_range_details(formula):
    """Return list of (ref, range_span) tuples from a formula.
       range_span = end_row - start_row for vertical ranges."""
    spans = []
    for m in re.finditer(r'(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?\d+)', formula):
        ref1, ref2 = m.group(1), m.group(2)
        col1 = re.search(r'[A-Z]+', ref1).group()
        row1 = int(re.search(r'\d+', ref1).group())
        col2 = re.search(r'[A-Z]+', ref2).group()
        row2 = int(re.search(r'\d+', ref2).group())
        if col1 == col2:
            span = abs(row2 - row1)
            spans.append((ref1 + ':' + ref2, span))
    return spans


def group_formulas_by_position(all_sheets):
    """Given {sheet_name: {cell_addr: formula}}, build position -> [(sheet, formula)] for weekly sheets."""
    # Collect all unique positions and their formulas per sheet
    pos_map = defaultdict(list)  # pos -> [(sheet, formula)]
    for sheet, cells in all_sheets.items():
        for addr, fmla in cells.items():
            pos_map[addr].append((sheet, fmla))
    return pos_map


def find_off_by_one(group):
    """Check if any pair in group differs by exactly one cell in a range span."""
    spans_list = []
    for sheet, fmla in group:
        for ref, span in extract_range_details(fmla):
            spans_list.append((sheet, ref, span))

    # Compare each pair
    differences = []
    for i in range(len(spans_list)):
        for j in range(i+1, len(spans_list)):
            s1, r1, sp1 = spans_list[i]
            s2, r2, sp2 = spans_list[j]
            if abs(sp1 - sp2) == 1:
                # Check if ranges share a column and overlapping row region
                col1 = re.search(r'[A-Z]+', r1).group()
                col2 = re.search(r'[A-Z]+', r2).group()
                row1_start = int(re.search(r'\d+', r1).group())
                row2_start = int(re.search(r'\d+', r2).group())
                if col1 == col2 and abs(row1_start - row2_start) <= 1:
                    differences.append((s1, r1, sp1, s2, r2, sp2))
    return differences


def find_copy_paste_errors(pos_map, weekly_sheets, threshold=0.7):
    """Find positions where most sheets agree on a formula but some disagree."""
    high_confidence = []  # (pos, majority_formula, dissenting)
    medium_confidence = []  # (pos, groups_of_similar_size)

    for addr in sorted(pos_map.keys()):
        group = pos_map[addr]
        if len(group) < 3:
            continue

        formulas_seen = Counter(fmla for _, fmla in group)
        total = len(group)
        most_common_fmla, most_count = formulas_seen.most_common(1)[0]

        # HIGH confidence: one formula dominates (>threshold) and dissenters exist
        if most_count / total >= threshold and most_count < total:
            dissenting = [(s, f) for s, f in group if f != most_common_fmla]
            high_confidence.append({
                'pos': addr,
                'dominant_formula': most_common_fmla,
                'dominant_count': most_count,
                'total': total,
                'dissenting_formulas': formulas_seen,
                'dissenting_cells': dissenting,
            })
        # MEDIUM confidence: 3+ distinct groups of similar size (no clear majority)
        else:
            distinct_groups = formulas_seen.most_common()
            if len(distinct_groups) >= 3:
                counts = [c for _, c in distinct_groups]
                min_c = min(counts)
                max_c = max(counts)
                if max_c <= min_c * 2.5 and min_c >= 2:  # within ~2.5x of each other, at least 2 each
                    medium_confidence.append({
                        'pos': addr,
                        'groups': dict(distinct_groups),
                    })

    return high_confidence, medium_confidence


def find_off_by_one_across_weeks(pos_map, weekly_sheets):
    """Scan all positions for off-by-one range errors."""
    off_by_one_results = []
    for addr in sorted(pos_map.keys()):
        group = pos_map[addr]
        if len(group) < 2:
            continue
        diffs = find_off_by_one(group)
        if diffs:
            off_by_one_results.append({
                'pos': addr,
                'differences': diffs,
            })
    return off_by_one_results


def find_cross_sheet_ref_errors(all_sheets, weekly_sheets):
    """Check if weekly sheets inconsistently reference team sheets (T1-T12)."""
    # Gather all cross-sheet refs across weekly sheets
    # A "cross-sheet ref" is any 'TN' or 'Leaders', 'Overall', etc. pattern
    team_ref_pattern = re.compile(r"'?T\d+'?")
    other_refs_pattern = re.compile(r"'?(Leaders|Mens.*Overall|Lady.*Overall|MensOuts|LadyOuts|MensAvg|LadyAvg|Standings|Playoff|ScoreSheet)'?")

    sheet_refs = {}  # sheet -> set of referenced external names
    for name, cells in weekly_sheets.items():
        refs = set()
        for fmla in cells.values():
            for m in team_ref_pattern.finditer(fmla):
                refs.add(m.group())
            for m in other_refs_pattern.finditer(fmla):
                refs.add(m.group())
        sheet_refs[name] = refs

    # Find inconsistent refs: a ref present in some weeks but not others
    all_refs = set()
    for refs in sheet_refs.values():
        all_refs.update(refs)

    inconsistencies = {}
    for ref in sorted(all_refs):
        weeks_with = [s for s in sorted(sheet_refs) if ref in sheet_refs[s]]
        weeks_without = [s for s in sorted(sheet_refs) if ref not in sheet_refs[s]]
        if weeks_with and weeks_without:
            inconsistencies[ref] = {
                'present_in': weeks_with,
                'absent_from': weeks_without,
                'present_count': len(weeks_with),
                'total_weeks': len(sheet_refs),
            }

    return sheet_refs, inconsistencies


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def write_report(high_cf, medium_cf, off_by_one, cross_sheet_refs, ref_inconsistencies, output_path):
    lines = []
    W = lines.append

    W("=" * 120)
    W("FORMULA CONSISTENCY ANALYSIS REPORT")
    W("File: " + XLSX_PATH)
    W("Date: 2026-11-20")
    W("=" * 120)
    W("")

    # ---- HIGH CONFIDENCE COPY-PASTE ERRORS ----
    W("=" * 120)
    W("HIGH CONFIDENCE COPY-PASTE ERRORS")
    W("Formula at a given position is consistent across most weeks but differs in a few.")
    W(f"Found {len(high_cf)} positions with HIGH confidence errors.")
    W("=" * 120)
    W("")

    if not high_cf:
        W("  (none found)")
        W("")
    else:
        for idx, item in enumerate(high_cf, 1):
            W(f"--- Error #{idx} ---")
            W(f"  Position:          {item['pos']}")
            W(f"  Total weeks:       {item['total']}")
            W(f"  Dominant formula:  {item['dominant_formula'][:80]}{'...' if len(item['dominant_formula']) > 80 else ''}")
            W(f"  Dominant count:    {item['dominant_count']} weeks")
            W(f"  Formula distribution:")
            for fmla, cnt in item['dissenting_formulas'].most_common():
                marker = " <-- MAJORITY" if cnt == item['dominant_count'] else ""
                formula_display = (fmla[:80] + '...') if len(fmla) > 80 else fmla
                W(f"    {cnt:3d}x  {formula_display}{marker}")
            W(f"  Dissenting cells:")
            for sheet, fmla in item['dissenting_cells']:
                formula_display = (fmla[:80] + '...') if len(fmla) > 80 else fmla
                W(f"    {sheet}:  {formula_display}")
            W("")

    # ---- MEDIUM CONFIDENCE COPY-PASTE ERRORS ----
    W("=" * 120)
    W("MEDIUM CONFIDENCE COPY-PASTE ERRORS")
    W("Formula at a given position has 3+ distinct groups of similar size (no clear majority).")
    W(f"Found {len(medium_cf)} positions with MEDIUM confidence errors.")
    W("=" * 120)
    W("")

    if not medium_cf:
        W("  (none found)")
        W("")
    else:
        for idx, item in enumerate(medium_cf, 1):
            W(f"--- Error #{idx} ---")
            W(f"  Position: {item['pos']}")
            W(f"  Formula groups:")
            for fmla, cnt in item['groups'].items():
                formula_display = (fmla[:80] + '...') if len(fmla) > 80 else fmla
                W(f"    {cnt:3d}x  {formula_display}")
            W("")

    # ---- OFF-BY-ONE RANGE ERRORS ----
    W("=" * 120)
    W("OFF-BY-ONE RANGE ERRORS")
    W("Cells at the same position reference ranges that differ by exactly one cell.")
    W(f"Found {len(off_by_one)} positions with off-by-one errors.")
    W("=" * 120)
    W("")

    if not off_by_one:
        W("  (none found)")
        W("")
    else:
        for idx, item in enumerate(off_by_one, 1):
            W(f"--- Error #{idx} ---")
            W(f"  Position: {item['pos']}")
            for s1, r1, sp1, s2, r2, sp2 in item['differences']:
                W(f"    {s1}: {r1} (span={sp1})  vs  {s2}: {r2} (span={sp2})  => differs by 1 cell")
            W("")

    # ---- CROSS-SHEET REFERENCE ERRORS ----
    W("=" * 120)
    W("CROSS-SHEET REFERENCE INCONSISTENCIES")
    W("Team/other sheet references that appear in some weekly sheets but not others.")
    W(f"Found {len(ref_inconsistencies)} inconsistent cross-sheet references.")
    W("=" * 120)
    W("")

    if not ref_inconsistencies:
        W("  (none found)")
        W("")
    else:
        for idx, (ref, info) in enumerate(sorted(ref_inconsistencies.items()), 1):
            W(f"--- Inconsistency #{idx}: {ref} ---")
            W(f"  Present in       {info['present_count']} of {info['total_weeks']} weeks")
            W(f"  Present in:      {', '.join(info['present_in'])}")
            W(f"  Absent from:     {', '.join(info['absent_from'])}")
            W("")

    # ---- FULL CROSS-SHEET REFERENCE MAP ----
    W("=" * 120)
    W("FULL CROSS-SHEET REFERENCE MAP")
    W("Which team/other sheets each weekly sheet references.")
    W("=" * 120)
    W("")

    if cross_sheet_refs:
        # Determine column width for alignment
        max_sheet_len = max(len(s) for s in cross_sheet_refs) if cross_sheet_refs else 15
        all_refs_sorted = set()
        for refs in cross_sheet_refs.values():
            all_refs_sorted.update(refs)
        all_refs_sorted = sorted(all_refs_sorted)

        header = f"{'Sheet':<{max_sheet_len}}" + ''.join(f'{r:^10}' for r in all_refs_sorted)
        W(header)
        W('-' * len(header))
        for sheet_name in sorted(cross_sheet_refs.keys()):
            if not re.match(r'^W\d+$', sheet_name):
                continue  # only weekly sheets
            refs = cross_sheet_refs[sheet_name]
            row = f"{sheet_name:<{max_sheet_len}}" + ''.join(
                'YES      ' if r in refs else '           ' for r in all_refs_sorted
            )
            W(row)

    W("")
    W("=" * 120)
    W("END OF REPORT")
    W("=" * 120)

    report_text = '\n'.join(lines)
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(report_text)
    
    return report_text


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print(f"Loading XLSX: {XLSX_PATH}")
    t0 = time.time()
    all_sheets, ws_names = collect_formulas(XLSX_PATH)
    load_time = time.time() - t0
    print(f"Loaded in {load_time:.1f}s — {len(all_sheets)} sheets")

    # Identify weekly sheets
    weekly_sheets = {}
    other_sheets = {}
    for name, formulas in all_sheets.items():
        if re.match(r'^W\d+$', name):
            weekly_sheets[name] = formulas
        else:
            other_sheets[name] = formulas

    print(f"Weekly sheets (W1-W22): {sorted(weekly_sheets.keys())}")
    print(f"Other sheets: {list(other_sheets.keys())}")
    print(f"Formula counts per weekly sheet:")
    for s in sorted(weekly_sheets):
        print(f"  {s}: {len(weekly_sheets[s])} formulas")

    # Position map (across ALL sheets)
    print("\nBuilding position map...")
    t1 = time.time()
    pos_map = group_formulas_by_position(all_sheets)
    print(f"Position map built in {time.time()-t1:.1f}s — {len(pos_map)} unique positions")

    # 1. Copy-paste errors
    print("\nAnalyzing copy-paste errors...")
    t2 = time.time()
    high_cf, medium_cf = find_copy_paste_errors(pos_map, weekly_sheets)
    print(f"  HIGH confidence: {len(high_cf)} positions ({time.time()-t2:.1f}s)")
    print(f"  MEDIUM confidence: {len(medium_cf)} positions")

    # 2. Off-by-one range errors
    print("\nAnalyzing off-by-one range errors...")
    t3 = time.time()
    off_by_one = find_off_by_one_across_weeks(pos_map, weekly_sheets)
    print(f"  Found: {len(off_by_one)} positions ({time.time()-t3:.1f}s)")

    # 3. Cross-sheet reference inconsistencies
    print("\nAnalyzing cross-sheet reference inconsistencies...")
    t4 = time.time()
    sheet_refs, ref_inconsistencies = find_cross_sheet_ref_errors(all_sheets, weekly_sheets)
    print(f"  Found: {len(ref_inconsistencies)} inconsistent references ({time.time()-t4:.1f}s)")

    # Summary stats
    total_positions = len(pos_map)
    positions_with_errors = len(high_cf) + len(medium_cf) + len(off_by_one)
    # Deduplicate positions across categories
    all_error_positions = set()
    for item in high_cf: all_error_positions.add(item['pos'])
    for item in medium_cf: all_error_positions.add(item['pos'])
    for item in off_by_one: all_error_positions.add(item['pos'])

    print(f"\n{'='*60}")
    print(f"SUMMARY")
    print(f"{'='*60}")
    print(f"Total unique cell positions:  {total_positions}")
    print(f"Positions with formula errors:{len(all_error_positions)}")
    print(f"  HIGH confidence errors:     {len(high_cf)}")
    print(f"  MEDIUM confidence errors:   {len(medium_cf)}")
    print(f"  Off-by-one range errors:    {len(off_by_one)}")
    print(f"  Cross-sheet ref issues:     {len(ref_inconsistencies)}")

    # Write report
    output_path = r"C:\Users\Paul\Projects\The-701-Club\formula_analysis_report.txt"
    print(f"\nWriting detailed report to: {output_path}")
    t5 = time.time()
    write_report(high_cf, medium_cf, off_by_one, sheet_refs, ref_inconsistencies, output_path)
    print(f"Report written in {time.time()-t5:.1f}s")
    total_time = time.time() - t0
    print(f"\nTotal analysis time: {total_time:.1f}s")


if __name__ == '__main__':
    main()
