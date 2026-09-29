import { Marked } from "marked";

// Markdown for bot output. Raw HTML is dropped, so the only markup that reaches
// the page is what marked emits; links are rewritten after parsing and unsafe
// schemes lose their href.
const marked = new Marked({ gfm: true, breaks: true });
marked.use({ renderer: { html: () => "" } });

export function renderMarkdown(source: string): string {
	const html = marked.parse(source) as string;
	const template = document.createElement("template");
	template.innerHTML = html;
	for (const anchor of template.content.querySelectorAll("a[href]")) {
		const href = anchor.getAttribute("href") ?? "";
		if (/^\s*(?:javascript|data|vbscript):/i.test(href)) {
			anchor.replaceWith(...Array.from(anchor.childNodes));
			continue;
		}
		anchor.setAttribute("target", "_blank");
		anchor.setAttribute("rel", "noopener noreferrer");
		if (anchor.textContent === href) anchor.classList.add("url");
	}
	return template.innerHTML;
}
