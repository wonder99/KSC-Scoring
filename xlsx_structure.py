import zipfile
import re
from collections import defaultdict, Counter
import sys

xlsx_path = r'C:\Users\Paul\Downloads\MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx'

# First, find sheet XML files and their names from workbook.xml
with zipfile.ZipFile(xlsx_path, 'r') as zf:
    # Get sheet names from workbook.xml
    wb_content = zf.read('xl/workbook.xml').decode()
    sheet_names_raw = re.findall(r'name="([^"]*)"', wb_content)
    
    # Map sheet IDs to names (ordered by order attribute)
    sheet_ids = re.findall(r'id="([^"]*)".*?name="([^"]*)"', wb_content)
    # Simpler: parse the sheet order
    sheets_ordered = re.findall(r'<sheet [^>]*>', wb_content)
    
    for idx, sheet_xml in enumerate(sheets_ordered):
        match_id = re.search(r'id="(.*?)"', sheet_xml)
        match_name = re.search(r'name="(.*?)"', sheet_xml)
        match_order = re.search(r'order="(\d+)"', sheet_xml)
        if match_id and match_name:
            print(f"  order={match_order.group(1) if match_order else '?'} id={match_id.group(1)} name=\"{match_name.group(1)}\"")
