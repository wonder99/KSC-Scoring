import zipfile
import re
from collections import defaultdict, Counter

xlsx_path = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

with zipfile.ZipFile(xlsx_path, 'r') as zf:
    all_names = [n for n in zf.namelist() if not n.startswith('__')]

print(f"Total files in xlsx: {len(all_names)}")

sheet_names_order = [
    'W22','W21','W20','W19','W18','W17','W16','W15','W14','W13',
    'W12','W11','W10','W9','W8','W7','W6','W5','W4','W3','W2',
    'W1 - Team Master',
    'T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12',
    'Leaders','Mens Overall','Mens Outs','Mens Avg','Mens 95',
    'Lady Overall','Lady Outs','Lady Avg','Lady 95',
    'Standings','Playoff Standings','ScoreSheet'
]

sheet_formula_counts = {}

with zipfile.ZipFile(xlsx_path, 'r') as zf:
    all_names = [n for n in zf.namelist() if not n.startswith('__')]
    
    print(f"\nTotal files in xlsx: {len(all_names)}")

    for xml_file in sorted([n for n in all_names if 'worksheets/sheet' in n.lower() and n.endswith('.xml')]):
        content = zf.read(xml_file).decode('utf-8', errors='replace')

        # Count </f> elements - each indicates a cell with a formula
        f_elements = len(re.findall(r'</f>', content))

        idx = int(re.search(r'sheet(\d+)\.xml', xml_file).group(1))
        sheet_name = sheet_names_order[idx - 1] if idx <= len(sheet_names_order) else f"unknown_{idx}"

        sheet_formula_counts[sheet_name] = f_elements

print("\n=== Formula counts per sheet ===")
for name, count in sorted(sheet_formula_counts.items(), key=lambda x: -x[1]):
    bar = '#' * min(count // 20, 80)
    print(f"  {name:25s} {count:>6d} formulas  {bar}")
