#!/usr/bin/env python3
"""Unpack an MIT OCW site-mirror (zip extract) into the Obsidian course vault.

Usage:
    ocw_unpack.py --src /tmp/18.01sc --course 18.01 [--dst DIR] [--inventory]

  --src        extracted mirror dir (contains pages/, resources/, static_resources/)
  --course     key in CONFIGS below (patterns, folder names, urls)
  --dst        vault course folder; default ~/Documents/Notes/education/<folder>
  --inventory  print the mirror's shape + how resources classify, then exit

Build output (idempotent — existing files are skipped):
    <dst>/sc/unit-N-*/part-*/sN-*/   session notes, problems, solutions, transcripts
    <dst>/exams/                     examN.pdf, examN-solutions.pdf, final*
    <dst>/problem-sets/books/        <book>-problems.pdf / <book>-solutions.pdf
    <dst>/syllabus.md                session index (videos stay external links)

Session, problem-set and exam bullets in syllabus.md are checkboxes; a rebuild
re-reads the existing file and re-applies the checked state.
"""
import argparse, collections, glob, json, os, re, shutil, sys, urllib.parse

# --------------------------------------------------------------------------
# Course configs. Add one entry per course; `--inventory` shows what its
# resource file names look like so the patterns can be filled in.
# Group meanings: note=(session nr, letter), problem=(nr, letter, prb|sol),
# book=(book nr, prb|sol), exam=(examN|final, sol?).
# --------------------------------------------------------------------------
CONFIGS = {
    '18.01': {
        'folder': '18.01',
        'url': 'https://ocw.mit.edu/courses/18-01sc-single-variable-calculus-fall-2010/',
        'syllabus_title': '18.01SC — syllabus & session index',
        'syllabus_heading': '18.01SC — Single Variable Calculus',
        'note_res': [r'MIT18_?0?1SCF10_Ses(\d+)([a-z]*)\.pdf$',
                     r'MIT18_?10SCF10_Ses(\d+)([a-z]*)\.pdf$'],
        'problem_re': r'MIT18_01SCF10_ex(\d+)([a-z]*)(prb|sol)\.pdf$',
        'book_re': r'MIT18_01SC_pset(\d+)(prb|sol)\.pdf$',
        'exam_re': r'MIT18_01SCF10_(exam(\d)|final)(sol)?\.pdf$',
        'final_title': r'Materials for Final Exam',
        'units': {
            '1.-differentiation': 'unit-1-differentiation',
            'unit-2-applications-of-differentiation': 'unit-2-applications-of-differentiation',
            'unit-3-the-definite-integral-and-its-applications': 'unit-3-the-definite-integral-and-its-applications',
            'unit-4-techniques-of-integration': 'unit-4-techniques-of-integration',
            'unit-5-exploring-the-infinite': 'unit-5-exploring-the-infinite',
        },
        'books': {'1': 'differentiation', '2': 'applications-of-differentiation',
                  '3': 'integration', '4': 'applications-of-integration',
                  '5': 'integration-techniques'},
        'folder_fix': {'review-for-exam-3': 's66-review-for-exam-3'},
    },
}

# --------------------------------------------------------------------------
# mirror loading
# --------------------------------------------------------------------------
def load(src):
    pages = {}
    for p in glob.glob(f'{src}/pages/**/data.json', recursive=True):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        if d.get('content_type') != 'page':
            continue
        d['_dir'] = os.path.dirname(p)
        pages[d['uid']] = d
    kids = collections.defaultdict(list)
    for uid, d in pages.items():
        kids[d.get('parent_uid')].append(uid)
    roots = [u for u in pages if pages[u].get('parent_uid') not in pages]

    res = []
    for p in glob.glob(f'{src}/resources/*/data.json'):
        try:
            d = json.load(open(p))
        except Exception:
            continue
        d['_folder'] = os.path.dirname(p)
        res.append(d)
    return pages, kids, roots, res


def clean_name(f):
    return re.sub(r'^[0-9a-f]{32}_', '', f or '')


def static_path(d, src):
    f = d.get('file') or ''
    if not f:
        return None
    cand = f'{src}/static_resources/{os.path.basename(f)}'
    if os.path.exists(cand):
        return cand
    uid = (d.get('uid') or '').replace('-', '')
    c2 = glob.glob(f'{src}/static_resources/{uid}_*')
    return c2[0] if c2 else None


def is_pdf(d):
    return d.get('file_type') == 'application/pdf' or (d.get('file') or '').lower().endswith('.pdf')


def yt_link(video_d, deeplink=False):
    yt = (video_d.get('video_metadata') or {}).get('youtube_id')
    if not yt:
        return None
    if deeplink and video_d.get('start_time'):
        try:
            return f'https://youtu.be/{yt}?t={int(float(video_d["start_time"]))}'
        except Exception:
            pass
    return f'https://youtu.be/{yt}'


def caption_paths(video_d, src):
    """Local caption file for a video resource (prefer .srt)."""
    found = []
    vf = video_d.get('video_files') or {}
    for c in (vf.get('video_captions_resources') or []):
        f = c.get('file') or ''
        if f:
            p = f'{src}/static_resources/{os.path.basename(f)}'
            if os.path.exists(p):
                found.append(p)
    yt = (video_d.get('video_metadata') or {}).get('youtube_id')
    if yt:
        found = glob.glob(f'{src}/static_resources/*_{yt}.srt') + \
                glob.glob(f'{src}/static_resources/*_{yt}.vtt') + found
    srt = [p for p in found if p.endswith('.srt')]
    return (srt or found or [None])[0]


def classify_session_files(parent, by, cfg):
    out = {'notes': [], 'extra': [], 'prb': [], 'sol': [], 'videos': []}
    for d in by.get(parent, []):
        f = clean_name(os.path.basename(d.get('file') or ''))
        if d.get('resourcetype') == 'Video':
            out['videos'].append(d)
            continue
        if not is_pdf(d):
            continue
        for rx in cfg['note_res']:
            m = re.match(rx, f)
            if m:
                out['notes'].append((m.group(2), d))
                break
        else:
            m = re.match(cfg['problem_re'], f)
            if m:
                out['prb' if m.group(3) == 'prb' else 'sol'].append((m.group(2), d))
            elif 'Lecture Notes' in (d.get('learning_resource_types') or []):
                out['extra'].append(d)
    for k in ('notes', 'prb', 'sol'):
        out[k].sort(key=lambda x: x[0])
    return out


def slug_to_folder(slug, cfg):
    m = re.match(r'^session-(\d+)-(.+)$', slug)
    if m:
        return f's{m.group(1)}-{m.group(2)}'
    return cfg.get('folder_fix', {}).get(slug, slug)


def natkey(title):
    m = re.match(r'^(\d+)\.', title or '')
    return (0, int(m.group(1))) if m else (1, title or '')


def sessnum(title):
    m = re.match(r'^Session (\d+)', title or '')
    return int(m.group(1)) if m else 10 ** 9


def read_states(path):
    """Checked state per bullet, keyed session:N / pset:N / exam:N / final."""
    st = {}
    if not os.path.exists(path):
        return st
    for line in open(path):
        m = re.match(r'^- \[([ xX])\] ', line)
        if not m:
            continue
        rest = line[m.end():]
        ms = re.match(r'\*\*(Session (\d+)|Problem Set (\d+))', rest)
        me = re.match(r'\[Exam (\d+)\]', rest)
        if ms:
            key = f'session:{ms.group(2)}' if ms.group(2) else f'pset:{ms.group(3)}'
        elif me:
            key = f'exam:{me.group(1)}'
        elif rest.startswith('[Final exam]'):
            key = 'final'
        else:
            continue
        st[key] = m.group(1).lower() == 'x'
    return st


def checkboxize(line, states):
    """Prepend a checkbox to session / problem-set / exam bullets."""
    key = None
    m = re.match(r'^- \*\*(Session (\d+)|Problem Set (\d+))', line)
    if m:
        key = f'session:{m.group(2)}' if m.group(2) else f'pset:{m.group(3)}'
    else:
        m = re.match(r'^- \[Exam (\d+)\]', line)
        if m:
            key = f'exam:{m.group(1)}'
        elif re.match(r'^- \[Final exam\]', line):
            key = 'final'
    if key is None or not line.startswith('- '):
        return line
    box = '[x]' if states.get(key) else '[ ]'
    return '- ' + box + ' ' + line[2:]


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def build(src, dst, cfg):
    pages, kids, roots, res = load(src)
    sc = os.path.join(dst, 'sc')
    by = collections.defaultdict(list)
    for d in res:
        by[d.get('parent_title')].append(d)

    counts = collections.Counter()
    syllabus = []

    def rel(p):
        return urllib.parse.quote(os.path.relpath(p, dst))

    def copy(s, d):
        os.makedirs(os.path.dirname(d), exist_ok=True)
        if os.path.exists(d):
            counts['skipped'] += 1
        else:
            shutil.copy2(s, d)
            counts['copied'] += 1
        return d

    def ocw_url(page_d):
        d = os.path.relpath(page_d['_dir'], src)
        assert d.startswith('pages/'), d
        return cfg['url'] + d + '/'

    def note_links(f, sdir):
        links = []
        for letter, d in f['notes']:
            sp = static_path(d, src)
            if not sp:
                continue
            name = f'notes-{letter}.pdf' if letter else 'notes.pdf'
            d2 = os.path.join(sdir, name)
            copy(sp, d2)
            links.append(f'[notes {letter or ""}]({rel(d2)})'.replace('notes ]', 'notes]'))
        for d in f['extra']:
            sp = static_path(d, src)
            if not sp:
                continue
            base = clean_name(os.path.basename(d.get('file') or 'extra.pdf'))
            d2 = os.path.join(sdir, f'notes-{base}')
            copy(sp, d2)
            links.append(f'[notes extra]({rel(d2)})')
        return links

    def session_video_links(f, sdir):
        parts = []
        lect = {}
        for v in f['videos']:
            if 'Lecture Videos' not in (v.get('learning_resource_types') or ['']):
                continue
            yt = (v.get('video_metadata') or {}).get('youtube_id')
            if not yt:
                continue
            cur = lect.setdefault(yt, {'min': None})
            st = v.get('start_time')
            if st and (cur['min'] is None or float(st) < cur['min']):
                cur['min'] = float(st)
        vi = 0
        for yt, info in lect.items():
            vi += 1
            link = f"https://youtu.be/{yt}?t={int(info['min'])}" if info['min'] else f'https://youtu.be/{yt}'
            label = 'lecture video' if len(lect) == 1 else f'lecture video {vi}'
            cap = None
            for v in f['videos']:
                if (v.get('video_metadata') or {}).get('youtube_id') == yt:
                    cap = caption_paths(v, src)
                    break
            txt = ''
            if cap:
                ext = '.srt' if cap.endswith('.srt') else '.vtt'
                name = f'lecture{ext}' if len(lect) == 1 else f'lecture-{vi}{ext}'
                d2 = os.path.join(sdir, name)
                copy(cap, d2)
                txt = f' · [transcript]({rel(d2)})'
            parts.append(f'[{label}]({link}){txt}')
        for v in f['videos']:
            if 'Problem-solving Videos' not in (v.get('learning_resource_types') or ['']):
                continue
            link = yt_link(v)
            if not link:
                continue
            cap = caption_paths(v, src)
            txt = ''
            if cap:
                ext = '.srt' if cap.endswith('.srt') else '.vtt'
                slug = re.sub(r'[^a-z0-9]+', '-', (v.get('title') or 'video').lower()).strip('-')[:60]
                d2 = os.path.join(sdir, f'video-{slug}{ext}')
                copy(cap, d2)
                txt = f' [transcript]({rel(d2)})'
            parts.append(f"[video: {v.get('title')}]({link}){txt}")
        return parts

    def session_line(s, sdir):
        f = classify_session_files(s['title'], by, cfg)
        parts = [f"**{s['title']}** — [OCW page]({ocw_url(s)})"]
        parts += session_video_links(f, sdir)
        nl = note_links(f, sdir)
        if nl:
            parts.append(' '.join(nl))
        for kind, label in (('prb', 'problems'), ('sol', 'solutions')):
            for letter, d in f[kind]:
                sp = static_path(d, src)
                if not sp:
                    continue
                name = f'{label}-{letter}.pdf' if letter else f'{label}.pdf'
                d2 = os.path.join(sdir, name)
                copy(sp, d2)
                parts.append(f"[{label}{' ' + letter if letter else ''}]({rel(d2)})")
        return '- ' + ' · '.join(parts)

    def process_part(part_d, unit_folder, indent):
        part_dir = os.path.join(sc, unit_folder, os.path.basename(part_d['_dir']))
        children = [pages[u] for u in kids[part_d['uid']]]
        lines = []
        sessions = sorted([c for c in children if str(c.get('title', '')).startswith('Session ')],
                          key=lambda c: sessnum(c['title']))
        psets = sorted([c for c in children if str(c.get('title', '')).startswith('Problem Set ')],
                       key=lambda c: sessnum(c['title'].replace('Problem Set', 'Session')))
        for s in sessions:
            sdir = os.path.join(part_dir, slug_to_folder(os.path.basename(s['_dir']), cfg))
            lines.append(session_line(s, sdir))
        for ps in psets:
            books, seen = [], set()
            for d in by.get(ps['title'], []):
                m = re.match(cfg['book_re'], clean_name(os.path.basename(d.get('file') or '')))
                if m:
                    b = (cfg['books'][m.group(1)], m.group(2))
                    if b not in seen:
                        seen.add(b)
                        books.append(b)
            links = []
            for bname, kind in sorted(books):
                p = os.path.join(dst, 'problem-sets', 'books',
                                 f'{bname}-{"problems" if kind == "prb" else "solutions"}.pdf')
                if os.path.exists(p):
                    links.append(f'[{bname if kind == "prb" else bname + " solutions"}]({rel(p)})')
            lines.append(f"- **{ps['title']}** — [assigned exercises](problem-sets/README.md) · " + ' · '.join(links))
        if lines:
            syllabus.append((indent, part_d.get('title'), lines))

    def process_exam(exam_d, unit_folder, indent):
        exam_dir = os.path.join(sc, unit_folder, os.path.basename(exam_d['_dir']))
        num = re.search(r'(\d+)', exam_d['title']).group(1)
        lines = [f'- [Exam {num}]({rel(os.path.join(dst, "exams", f"exam{num}.pdf"))})'
                 f' · [solutions]({rel(os.path.join(dst, "exams", f"exam{num}-solutions.pdf"))})']
        for u in sorted(kids[exam_d['uid']], key=lambda u: sessnum(pages[u]['title'])):
            s = pages[u]
            sdir = os.path.join(exam_dir, slug_to_folder(os.path.basename(s['_dir']), cfg))
            f = classify_session_files(s['title'], by, cfg)
            parts = [f"**{s['title']}** — [OCW page]({ocw_url(s)})"]
            nl = note_links(f, sdir)
            if nl:
                parts.append(' '.join(nl))
            lines.append('- ' + ' · '.join(parts))
        syllabus.append((indent, exam_d['title'], lines))

    def process_unit(unit_d):
        unit_slug = os.path.basename(unit_d['_dir'])
        unit_folder = cfg['units'].get(unit_slug, unit_slug)
        syllabus.append((0, unit_d.get('title'), []))
        children = [pages[u] for u in kids[unit_d['uid']]]
        for c in sorted([c for c in children if str(c.get('title', '')).startswith('Part ')],
                        key=lambda c: natkey(c.get('title'))):
            process_part(c, unit_folder, 1)
        for c in sorted([c for c in children if str(c.get('title', '')).startswith('Exam ')],
                        key=lambda c: c['title']):
            process_exam(c, unit_folder, 1)

    # -- problem books and exams first, so session lines can link them
    seen = set()
    for d in res:
        fb = clean_name(os.path.basename(d.get('file') or ''))
        if fb in seen:
            continue
        m = re.match(cfg['book_re'], fb)
        if m:
            seen.add(fb)
            bname = cfg['books'][m.group(1)]
            kind = 'problems' if m.group(2) == 'prb' else 'solutions'
            sp = static_path(d, src)
            if sp:
                copy(sp, os.path.join(dst, 'problem-sets', 'books', f'{bname}-{kind}.pdf'))
            continue
        m = re.match(cfg['exam_re'], fb)
        if m:
            seen.add(fb)
            stem = 'final' if m.group(1) == 'final' else f'exam{m.group(2)}'
            name = f"{stem}{'-solutions' if m.group(3) else ''}.pdf"
            sp = static_path(d, src)
            if sp:
                copy(sp, os.path.join(dst, 'exams', name))

    # -- walk roots
    os.makedirs(sc, exist_ok=True)
    final_lines = []
    for r in sorted(roots, key=lambda u: natkey(pages[u].get('title') or '')):
        d = pages[r]
        t = d.get('title') or ''
        if t == 'Syllabus':
            continue
        if re.search(cfg['final_title'], t):
            for dd in by.get(t, []):
                fb = clean_name(os.path.basename(dd.get('file') or ''))
                m = re.match(cfg['exam_re'], fb)
                if not m:
                    continue
                stem = 'final' if m.group(1) == 'final' else f'exam{m.group(2)}'
                name = f"{stem}{'-solutions' if m.group(3) else ''}.pdf"
                sp = static_path(dd, src)
                if sp:
                    copy(sp, os.path.join(dst, 'exams', name))
            final_lines.append(f'- [Final exam]({rel(os.path.join(dst, "exams", "final.pdf"))})'
                               f' · [solutions]({rel(os.path.join(dst, "exams", "final-solutions.pdf"))})')
            final_lines.append(f'- {t} — [OCW page]({ocw_url(d)})')
            continue
        if re.match(r'^\d+\.', t):
            process_unit(d)
    syllabus.append((0, 'Final Exam', final_lines))

    # -- syllabus
    import datetime
    out = ['---', f'title: "{cfg["syllabus_title"]}"',
           f'updated: "{datetime.date.today().isoformat()}"', '---', '',
           f'# {cfg["syllabus_heading"]}', '',
           'Session-by-session index of the local course materials under `sc/`. Videos link out to YouTube;',
           'lecture transcripts, notes, problems and solutions are local. Exam PDFs are in `exams/`;',
           'problem books in `problem-sets/books/`. Assigned exercises per problem set: `problem-sets/README.md`.',
           '', f'Course page: {cfg["url"]}', '']
    states = read_states(os.path.join(dst, 'syllabus.md'))
    for indent, title, lines in syllabus:
        out += ['#' * (2 + indent) + ' ' + title, ''] + \
               [checkboxize(l, states) for l in lines] + ['']
    open(os.path.join(dst, 'syllabus.md'), 'w').write('\n'.join(out))
    return counts, len(out)


# --------------------------------------------------------------------------
# inventory
# --------------------------------------------------------------------------
def inventory(src, cfg):
    pages, kids, roots, res = load(src)
    print(f'pages: {len(pages)}   resources: {len(res)}')
    print('resourcetype:', dict(collections.Counter(d.get('resourcetype') for d in res)))
    print(f'static_resources files: {len(glob.glob(f"{src}/static_resources/*"))}')
    for r in sorted(roots, key=lambda u: natkey(pages[u].get("title") or "")):
        t = pages[r].get('title')
        ch = [pages[u].get('title') for u in kids[r]]
        print(f'ROOT {t!r}  ({len(ch)} children)')
        for x in ch[:14]:
            print('   ', x)
        if len(ch) > 14:
            print(f'    … {len(ch) - 14} more')
    buckets = collections.Counter()
    samples = collections.defaultdict(list)
    unmatched = collections.Counter()
    vids = sum(1 for d in res if d.get('resourcetype') == 'Video')
    vids_yt = sum(1 for d in res if (d.get('video_metadata') or {}).get('youtube_id'))
    print(f'videos: {vids} ({vids_yt} with youtube ids)')
    for d in res:
        f = clean_name(os.path.basename(d.get('file') or ''))
        hit = None
        for rx, tag in ([(rx, 'note') for rx in cfg['note_res']] +
                        [(cfg['problem_re'], 'problem'), (cfg['book_re'], 'book'),
                         (cfg['exam_re'], 'exam')]):
            if re.match(rx, f):
                hit = tag
                break
        if hit:
            buckets[hit] += 1
            if len(samples[hit]) < 4:
                samples[hit].append(f)
        elif 'Lecture Notes' in (d.get('learning_resource_types') or []):
            buckets['extra-notes'] += 1
            if len(samples['extra-notes']) < 4:
                samples['extra-notes'].append(f)
        elif is_pdf(d):
            unmatched[f] += 1
    for k, v in sorted(buckets.items()):
        print(f'{k}: {v}  e.g. {samples[k]}')
    print(f'other PDFs: {sum(unmatched.values())}')
    for f, c in unmatched.most_common(25):
        print(f'   {c}x {f}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--course', required=True)
    ap.add_argument('--dst')
    ap.add_argument('--inventory', action='store_true')
    a = ap.parse_args()
    if a.course not in CONFIGS:
        sys.exit(f'unknown course {a.course!r}; add a CONFIGS entry first')
    cfg = CONFIGS[a.course]
    if a.inventory:
        inventory(a.src, cfg)
        return
    dst = a.dst or os.path.expanduser(f'~/Documents/Notes/education/{cfg["folder"]}')
    counts, lines = build(a.src, dst, cfg)
    print('dst:', dst)
    print('counts:', dict(counts))
    print('syllabus lines:', lines)


if __name__ == '__main__':
    main()
