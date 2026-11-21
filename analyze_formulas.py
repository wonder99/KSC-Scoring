import openpyxl
from collections import defaultdict, Counter
import re
import json

wb = openpyxl.load_workbook(r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx', data_only=False)

# Extract all formulas per sheet with row/col info
all_formulas = []
for ws in wb.worksheets:
    for row in ws.iter_rows():
        for cell in row:
            if cell.value and isinstance(cell.value, str) and cell.value.startswith('='):
                all_formulas.append({
                    'sheet': ws.title,
                    'row': cell.row,
                    'col': cell.column_letter,
                    'formula': cell.value,
                })

print(f"Total formula cells found: {len(all_formulas)}")
print(f"\nSheets with formulas:")
formulas_by_sheet = defaultdict(list)
for f in all_formulas:
    formulas_by_sheet[f['sheet']].append(f)

for sheet, formulas in sorted(formulas_by_sheet.items()):
    print(f"  {sheet}: {len(formulas)} formulas")

# ---- ANALYSIS PASSES ----
print("\n" + "="*80)
print("ANALYSIS 1: Formula types by sheet")
print("="*80)

for sheet, formulas in sorted(formulas_by_sheet.items()):
    types = Counter()
    for f in formulas:
        upper = f['formula'].upper().strip()
        # Get first function
        m = re.search(r'[A-Z_]+', upper)
        if m:
            func = m.group(0)[:15]
            types[func] += 1
    print(f"\n  {sheet} (total formulas: {len(formulas)}):")
    for func, count in types.most_common():
        if func != '':
            print(f"    {func}: {count}")

print("\n" + "="*80)
print("ANALYSIS 2: Check for hardcoded sheet references (cross-sheet)")
print("="*80)

for sheet, formulas in sorted(formulas_by_sheet.items()):
    cross_refs = []
    for f in formulas:
        ref_sheets = re.findall(r"([A-Z][A-Z]?(?:[1-9]\d*)?)'!([A-Z]+:\$?[A-Z]*\$?\d+)", f['formula'], re.IGNORECASE)
        # Also find single-quoted refs like 'Sheet Name'!A1
        quoted_refs = re.findall(r"'([^']+)'!\$?([A-Z]+)\$?(\d+)", f['formula'])
        for ref in quoted_refs:
            sheet_name = ref[0]
            if sheet_name != sheet and sheet_name != '' and not sheet_name.isdigit():
                cross_refs.append({
                    'self': f'sheet[{f["col"]}:{f["row"]}]',
                    'refers_to': sheet_name,
                    'cell_ref': f"{'$'.join(['' if ref[1].isdigit() else ref[1]] + ['' for _ in range(max(0,len(ref)-2))])}",
                    'formula': f['formula'][:80],
                })
    if cross_refs:
        print(f"\n  {sheet} references OTHER sheets:")
        seen = set()
        for cr in cross_refs:
            key = (cr['refers_to'], cr['formula'])
            if key not in seen:
                seen.add(key)
                print(f"    -> {cr['refers_to']}: {cr['formula']}")

print("\n" + "="*80)
print("ANALYSIS 3: Look for inconsistent reference styles (some with $, some without)")
print("="*80)

for sheet, formulas in sorted(formulas_by_sheet.items()):
    # Find all cell references
    refs_with_dollar = re.findall(r'\$[A-Z]+\$?\d+|\$[A-Z]+\$\d+', f' '.join(f['formula'] for f in formulas))
    refs_without_dollar = re.findall(r'(?<!\$)[A-Z]+\$?\d+(?!\$)', f' '.join(f['formula'] for f in formulas))
    
    # Find absolute vs mixed reference patterns
    abs_refs = re.findall(r'\$\$[A-Z]+\$\$\d+', f' '.join(f['formula'] for f in formulas))  # full absolute
    col_abs = re.findall(r'\$[A-Z]+\$[^A-Z]', f' '.join(f['formula'] for f in formulas))  # col abs, row rel
    row_abs = re.findall(r'[A-Z]+\$[0-9]+(?!\$)', f' '.join(f['formula'] for f in formulas))  # row abs, col rel
    
    if any([refs_with_dollar, refs_without_dollar, abs_refs, col_abs, row_abs]):
        print(f"\n  {sheet}:")
        # Detailed: per formula style
        for f in formulas[:5]:
            has_col_abs = bool(re.search(r'\$[A-Z]+\$', f['formula']))
            has_row_abs = bool(re.search(r'(?:\$)(?<![A-Z])\d+', f['formula'][f['formula'].find('$'):] if '$' in f['formula'] else '')) if '$' in f['formula'] else False
            
# Let me redo this more carefully
