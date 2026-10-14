#!/usr/bin/env python3
"""Check that every relative link in a markdown file resolves on disk.

Usage: check_links.py FILE.md [FILE.md ...]
Exit code 0 when nothing is missing, 1 otherwise.
"""
import os, re, sys, urllib.parse

LINK = re.compile(r'\]\(([^)\s]+)\)')


def check(path):
    base = os.path.dirname(os.path.abspath(path))
    n, missing = 0, []
    for m in LINK.finditer(open(path).read()):
        link = m.group(1)
        if re.match(r'^[a-z][a-z0-9+.-]*:', link) or link.startswith('#'):
            continue  # http(s):, mailto:, anchors
        n += 1
        target = urllib.parse.unquote(link.split('#')[0])
        if not os.path.exists(os.path.join(base, target)):
            missing.append(link)
    return n, missing


def main():
    bad = False
    for f in sys.argv[1:]:
        n, missing = check(f)
        print(f'{f}: {n} local links, {len(missing)} missing')
        for x in missing:
            print('  MISSING:', x)
            bad = True
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
