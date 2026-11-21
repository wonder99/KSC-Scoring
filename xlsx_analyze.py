import zipfile, re, time
from collections import defaultdict, Counter

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'


def main():
    t_start = time.time()
    print("Loading XLSX...")

    with zipfile.ZipFile(XLSX, 'r') as z:
        wb = z.read('xl/workbook.xml').decode('utf-8')

        # Map sheet position -> name (sequential index)
        pos_to_name = {}
        for i, m in enumerate(re.finditer(r'<sheet\s+name="([^"]+)"[^>]*r:id="rId(\d+)"', wb)):
            pos_to_name[i + 1] = m.group(1)

        # Read each sheet XML and extract formulas using simple string search (fastest)
        results = {}
        for inf in z.infolist():
            if 'worksheets/sheet' not in inf.filename or not inf.filename.endswith('.xml'):
                continue
            num = int(re.search(r'sheet(\d+)\.xml', inf.filename).group(1))
            name = pos_to_name.get(num, 'Sheet%d' % num)

            content = z.read(inf.filename).decode('utf-8')

            # Find all <c r="CELL"> tags and their <f> children using simple search
            formulas = []
            for cm in re.finditer(r'<c\s+r="([A-Z0-9]+)"[^>]*/?>', content):
                cell_ref = cm.group(1)
                # Find the corresponding </c> tag after this cell opening
                end_idx = content.find('</c>', cm.start())
                if end_idx == -1:
                    continue
                cell_block = content[cm.start():end_idx]
                f_match = re.search(r'<f>(.*?)</f>', cell_block, re.DOTALL)
                if f_match:
                    formula_text = ' '.join(f_match.group(1).split())  # normalize whitespace
                    if formula_text:
                        formulas.append((cell_ref, formula_text))

            if formulas:
                results[name] = formulas
                elapsed = time.time() - t_start
                print('%s: %d formulas (%.1fs)' % (name, len(formulas), elapsed))

        total = sum(len(f) for f in results.values())
        elapsed = time.time() - t_start
        print('\nTotal: %d formulas across %d sheets in %.1fs' % (total, len(results), elapsed))

    # === ANALYSIS 1: Cross-week consistency ===
    weekly_sheets = {}
    for name, formulas in results.items():
        if re.match(r'^W\d+$', name):
            weekly_sheets[name] = formulas

    print('\n' + '=' * 70)
    print('ANALYSIS 1: Cross-Week Positional Consistency')
    print('=' * 70)

    # Build map: cell position -> [(sheet, formula)]
    pos_map = defaultdict(list)
    for sheet, formulas in weekly_sheets.items():
        for cell_ref, formula in formulas:
            m2 = re.match(r'^([A-Z]+)(\d+)$', cell_ref)
            if m2:
                pos_key = '%s%d' % (m2.group(1), int(m2.group(2)))
                pos_map[pos_key].append((sheet, formula))

    anomalies_high = []
    anomalies_med = []

    for pos_key in sorted(pos_map.keys()):
        entries = pos_map[pos_key]
        if len(entries) < 2:
            continue

        # Group by function signature (just function names, no arguments)
        func_groups = defaultdict(list)
        for sheet, formula in entries:
            funcs = tuple(re.findall(r'\b([A-Z]{2,10})\(', formula))
            if funcs:
                func_groups[funcs].append((sheet, formula))

        if len(func_groups) <= 1:
            continue  # All sheets at this position use the same functions

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
        for pos_key, func_groups in sorted(anomalies_high, key=lambda x: x[0])[:50]:
            groups_dict = {}
            for i, (funcs, entries_list) in enumerate(func_groups.items()):
                sheets = sorted(entries_list, key=lambda x: int(re.search(r'(\d+)', x[0]).group()) if re.search(r'(\d+)', x[0]) else 999)
                groups_dict[str(i + 1)] = {
                    'funcs': list(funcs),
                    'count': len(sheets),
                    'sheets': [s[0] for s in sheets],
                    'sample': ' '.join(entries_list[0][1].split()) if entries_list else ''
                }

            majority_g = max(groups_dict.values(), key=lambda g: g['count'])
            minority_gs = [g for g in groups_dict.values() if g['count'] != majority_g['count']]

            print('  Position %s' % pos_key)
            print('    Majority (%d sheets): funcs=%s' % (majority_g['count'], majority_g['funcs']))
            sample1 = majority_g['sample'][:120] if majority_g['sample'] else ''
            print('      Sample: %s...' % sample1)
            for mg in minority_gs:
                affected = sorted(mg['sheets'], key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
                print('    Minority (%d sheet): funcs=%s' % (mg['count'], mg['funcs']))
                sample2 = mg['sample'][:120] if mg['sample'] else ''
                print('      Affected: %s' % ', '.join(affected[:5]))
                if sample2:
                    print('      Sample: %s...' % sample2)

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
            pos_key = '%s%d' % (m2.group(1), int(m2.group(2)))

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
        # Merge sheets across same range pair
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
                    team_refs[sheet][ref] += 1

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

    # Check for teams that should appear but don't in some weeks
    expected_teams = set(t for t, _ in all_teams.most_common())
    missing_data = {}
    for team in expected_teams:
        missing_from = sorted([w for w, r in team_refs.items() if not r.get(team, 0)], 
                              key=lambda s: int(re.search(r'(\d+)', s).group()) if re.search(r'(\d+)', s) else 999)
        if len(missing_from) > 0 and len(missing_from) < len(weekly_sheets):
            missing_data[team] = missing_from

    if missing_data:
        print('\nTeams not in all weeks:')
        for team, missing in sorted(missing_data.items()):
            print('  %s: missing from %d weeks (%s)' % (team, len(missing), ', '.join(missing[:5])))

    # Final summary
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
