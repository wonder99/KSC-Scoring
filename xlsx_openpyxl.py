import openpyxl
import re
from collections import defaultdict, Counter
import time

XLSX = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'


def main():
    t_start = time.time()
    print("Opening XLSX with openpyxl...")
    
    wb = openpyxl.load_workbook(XLSX, data_only=False, read_only=True)
    
    # For each sheet, extract formulas
    results = {}
    for name in wb.sheetnames:
        ws = wb[name]
        formulas = []
        
        for row in ws.iter_rows():
            for cell in row:
                if hasattr(cell, 'value') and cell.value is not None and isinstance(cell.value, str) and cell.data_type == 'f':
                    formula = cell.value
                    # Clean up the formula
                    clean_formula = re.sub(r'\s+', ' ', formula).strip()
                    if clean_formula:
                        formulas.append((cell.coordinate, clean_formula))
        
        results[name] = formulas
        elapsed = time.time() - t_start
        print('%s: %d formulas (%.1fs)' % (name, len(formulas), elapsed))
    
    wb.close()
    
    total_formulas = sum(len(f) for f in results.values())
    print('\nTotal: %d formulas across %d sheets in %.1fs' % (total_formulas, len(results), time.time()-t_start))


if __name__ == '__main__':
    main()
