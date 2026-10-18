"""Check required scaffold documents and local Markdown links."""
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]
failures = []
for name in ("README.md", "LICENSE", "CONTRIBUTING.md", "AGENTS.md"):
    path = root / name
    if not path.is_file() or not path.read_text(encoding="utf-8").strip():
        failures.append(f"Missing or empty required document: {name}")

for document in root.rglob("*.md"):
    if ".git" in document.relative_to(root).parts:
        continue
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", document.read_text(encoding="utf-8")):
        target = target.strip("<>")
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:|^#", target):
            continue
        target = target.split("#", 1)[0]
        if target and not (document.parent / target).exists():
            failures.append(f"{document.relative_to(root)}: missing local target {target}")
if failures:
    raise SystemExit("\n".join(failures))
print("Scaffold documents and local links are valid; runtime qualification is pending.")
