#!/usr/bin/env python3
"""split-proof.py [revision] [ui dir]: every top-level block of canals.js as it was at <revision> (default edf7c8b,
the last commit with one game script) is found verbatim in exactly one of the ui/canals*.js game files.

A block is a top-level declaration with the comments and blank lines above it. Blocks that aren't found verbatim are
listed by name: after the move-only split that was only the __canals object (its worksVfx setter calls the look
module's setWorksVfx); after the pure functions were broken up, those functions are listed too.

    python3 devtools/split-proof.py
    python3 devtools/split-proof.py edf7c8b /path/to/another/ui
"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
rev = sys.argv[1] if len(sys.argv) > 1 else "edf7c8b"
ui = sys.argv[2] if len(sys.argv) > 2 else os.path.join(REPO, "ui")
src = subprocess.run(["git", "-C", REPO, "show", f"{rev}:ui/canals.js"], capture_output=True, text=True,
                     check=True).stdout
lines = src.split("\n")

# trivia: blank lines, // lines, and lines inside a /* ... */ that starts a line
trivia, in_block = [], False
for ln in lines:
    s = ln.strip()
    if in_block:
        trivia.append(True)
        in_block = "*/" not in s
    elif s == "" or s.startswith("//"):
        trivia.append(True)
    elif s.startswith("/*"):
        trivia.append(True)
        in_block = "*/" not in s[2:]
    else:
        trivia.append(False)

DECL = re.compile(r'^(?:async function\*? |function\*? )([\w$]+)|^(?:const|let) ([\w$]+)|^(if \(!G\[KEY\]\))')
starts = [(i, (m.group(1) or m.group(2) or "the __canals object"))
          for i, ln in enumerate(lines) if not trivia[i] and (m := DECL.match(ln))]
first = next(i for i, ln in enumerate(lines) if ln.startswith("import "))
blocks, prev = [], first
for k, (s, name) in enumerate(starts):
    nxt = starts[k + 1][0] if k + 1 < len(starts) else len(lines)
    end = max(i for i in range(s, nxt) if not trivia[i])
    blocks.append((name, s + 1, "\n".join(lines[prev + 1:end + 1]).strip("\n")))
    prev = end
assert "\n".join(lines[prev + 1:]).strip() == "", "text after the last block"

GAME = re.compile(r"^canals(-[a-z]+)?\.js$")
files = {f: open(os.path.join(ui, f)).read() for f in sorted(os.listdir(ui))
         if GAME.match(f) and f not in ("canals-settings.js", "canals-options.js", "canals-shell.js")}
ok, off = 0, []
for name, line, text in blocks:
    hits = [f for f, body in files.items() for _ in range(body.count(text))]
    if len(hits) == 1:
        ok += 1
    else:
        off.append(f"  {name} (canals.js:{line}): {'not found' if not hits else 'in ' + ', '.join(hits)}")
header = "\n".join(lines[:first]).strip("\n")
print(f"canals.js at {rev}: {len(blocks)} blocks; {ok} verbatim in exactly one of {len(files)} files in {ui}")
print(f"header comment verbatim in canals.js: {files.get('canals.js', '').count(header) == 1}")
if off:
    print("not verbatim once:")
    print("\n".join(off))
