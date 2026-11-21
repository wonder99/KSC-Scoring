import openpyxl
import re
from collections import defaultdict, Counter
import time

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'


def get_formulas(wb):
    """Extract all formulas from workbook using openpyxl."""
    results = {}
    for name in wb.sheetnames:
        ws = wb[name]
        formulas = []
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type == 'f' and hasattr(cell, 'value') and cell.value:
                    formula = re.sub(r'\s+', ' ', cell.value.strip())
                    if formula:
                        formulas.append((cell.coordinate, formula))
        results[name] = formulas
    return results


def get_pos_key(coord):
    """Convert A1 -> ('A', 1)"""
    m = re.match(r'^([A-Z]+)(\d+)$', coord)
    if m:
        return (m.group(1), int(m.group(2)))
    return None


def main():
    t_start = time.time()
    print("Loading XLSX...")
    
    wb = openpyxl.load_workbook(XLSX, data_only=False, read_only=True)
    results = get_formulas(wb)
    wb.close()
    
    total = sum(len(f) for f in results.values())
    print('Extracted %d formulas across %d sheets in %.1fs\n' % (total, len(results), time.time()-t_start))
    
    # Print formula counts per sheet
    print("FORMULA COUNTS PER SHEET")
    print("=" * 60)
    for name, formulas in sorted(results.items()):
        if not formulas:
            continue
        funcs = set()
        for _, f in formulas:
            funcs.update(re.findall(r'\b([A-Z]{2,10})\(', f))
        top_funcs = sorted(funcs, key=lambda x: -sum(1 for _, f2 in formulas if re.search(r'\b' + x + r'\(', f2)))[:5]
        print('\n%s: %d formulas' % (name, len(formulas)))
        if top_funcs:
            print('    Top functions: %s' % ', '.join(top_funcs))
        samples = sorted(formulas[:3], key=lambda x: x[0])
        for cell, formula in samples:
            print('    %s: %s...' % (cell, formula[:80]))


if __name__ == '__main__':
    main()
