---
name: latex-pdf
description: Produce a polished single-topic PDF document with LaTeX. Use when Denis says "make a PDF", "put this in a pdf with LaTeX", "format it nicely as a document", or wants a printable/properly typeset version of content already in the conversation. For resumes use the existing resume sources instead of this skill.
---

# LaTeX PDF

Turn conversation content into a typeset PDF. The pipeline is fixed; the content
varies.

## Steps

1. **Create the project.** The LaTeX home is `~/dev/latex/` — one
   subdirectory per document. The root has a `devenv.nix`:

   ```nix
   { pkgs, ... }: {
     packages = [
       (pkgs.texliveMedium.withPackages (ps: with ps; [
         tcolorbox tikzfill environ etoolbox pgf
         enumitem xcolor titlesec
       ]))
     ];
   }
   ```

   Create `<doc>/`, put `<doc>/<doc>.tex` in it. Done when the `.tex` exists.
   Keep LaTeX work out of `~/Documents/Notes` while the LiveSync migration is ongoing.
2. **Verify the tooling** by compiling from the root:
   `devenv shell pdflatex -interaction=nonstopmode -output-directory=<doc> <doc>/<doc>.tex`.
   Done when no missing-package error appears. Known gotchas:
   - No system `pdflatex` exists — always go through the devenv shell at `~/dev/latex`.
   - `scheme-medium` via `nix-shell` (no devenv) misses packages; don't use it.
   - `texlive.combine` is deprecated; `texliveMedium.withPackages` is the form.
   - `\usepackage[most]{tcolorbox}` pulls in missing `tikzfill` — use
     `[skins]`, or add `tikzfill`. Denis's resume needs extra packages
     (fontawesome5, preprint, cyrillic, cm-super, lh, babel-russian).
3. **Write the `.tex`**. House style for document-type artifacts (problem sets,
   reviews, summaries — anything that isn't a resume):
   - `article`, 11pt, `a4paper`, margin ≈2.2cm.
   - Accent color `mitred` (RGB 163,31,52); section titles and headers in it.
   - Front matter as a centered title block: bold red title, gray subtitle,
     one-line metadata line.
   - A `tcolorbox` info box for framing/pacing/source notes near the top.
   - Numbered lists with descriptive labels (`enumitem`), math in
     `amsmath`, no `\parindent` (use `\parskip`).
   Done when the document renders the full content with no compile errors.
4. **Compile and verify.** Run the compile command from step 2, twice if
   the document has cross-references, then clean the aux files
   (`rm -f <doc>/<doc>.aux <doc>/<doc>.log`) and render a page to PNG
   (`pdftoppm -png -r 60 <doc>/<doc>.pdf /tmp/doc`) and view the image. Done when the
   PDF exists, has the expected page count, and a rendered page shows correct
   layout — font fallbacks, overflowing boxes, and broken math are visible only
   in the rendered page, not the exit code.
5. **Report the path** to the PDF and mention the `devenv` rebuild command.
