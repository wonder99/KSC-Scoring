"""Find errors on rows 42-52 in the report, showing which weekly sheets are affected."""

import re

with open(r"C:\Users\Paul\Projects\The-701-Club\formula_analysis_report.txt", encoding="utf-8") as f:
    content = f.read()

error_blocks = [b for b in re.split(r'(?=--- Error #)', content) if b.strip().startswith("--- Error")]

print("ERRORS ON ROWS 42-52 (weekly sheet dissenting cells only)")
print("=" * 80)

count = 0
for block in error_blocks:
    pos_match = re.search(r'Position:\s+(\w+)(\d+)', block)
    if not pos_match:
        continue
    col, row = pos_match.group(1), int(pos_match.group(2))
    
    # Check if position is on rows 42-52
    if row < 42 or row > 52:
        continue
    
    count += 1
    
    # Extract dissenting cells that are weekly sheets (W1-W22)
    dissent_weekly = re.findall(r'^\s{4}(W\d+):\s', block, re.MULTILINE)
    dissent_other = re.findall(r'^\s{4}((?:Mens|Lady|Leaders|Standings|T\d|W1 - Team Master)):\s', block, re.MULTILINE)
    
    if not dissent_weekly:
        continue  # no weekly sheet is a dissenting cell here
    
    print(f"\nError #{count}: Position {pos_match.group(0).strip()} (row {row})")
    print(f"  Dominant formula:      {block.split('Dominant formula:')[1].split('Dominant count:')[0].strip()[:90]}...")
    print(f"  Total sheets checked:  {block.split('Total weeks:')[1].split('\n')[0].strip()}")
    print(f"  Dissenting on W-sheets:")
    for ws in dissent_weekly:
        # Find which formula this sheet has
        line = re.search(rf'{ws}:\s+(.+)',$ block, re.MULTILINE)
        if line:
            fmla_display = line.group(1).strip()[:80]
            print(f"    {ws}: {fmla_display}")
    print(f"  Other dissenting sheets: {[s.rstrip(':').strip() for s in dissent_other if not re.match(r'^W\d+$', s)]}")

print(f"\n\nTotal errors on rows 42-52 with weekly sheet dissenters: {count}")

# Also show ALL errors on rows 42-52 regardless of dissenting sheets
print("\n\nALL ERRORS (any dissent) on rows 42-52:")
print("=" * 80)
count_all = 0
for block in error_blocks:
    pos_match = re.search(r'Position:\s+(\w+)(\d+)', block)
    if not pos_match:
        continue
    col, row = pos_match.group(1), int(pos_match.group(2))
    
    if row < 42 or row > 52:
        continue
    
    count_all += 1
    total_sheets = block.split('Total weeks:')[1].split('\n')[0].strip()
    dominant_count = block.split('Dominant count:')[1].split('\n')[0].strip()
    print(f"Error #{count_all}: Position {pos_match.group(0).strip()} — "
          f"{total_sheets} sheets, dominant={dominant_count}")

print(f"\nTotal errors on rows 42-52 (any dissent): {count_all}")
