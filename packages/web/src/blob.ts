import { gaze } from "blobatar/gaze";
import { _parts } from "blobatar/internal";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The blobatar as inline SVG, so it can move: it breathes on hover, and a live
 * one follows the pointer with its eyes. Inline rather than an `<img>` because
 * an image is an isolated document that neither hover nor the gaze driver can
 * reach.
 *
 * `_parts` is the adapter hook of the blobatar package, and the only way to get
 * the animated markup without a framework. Its shape changes with blobatar
 * majors; `blobatar()` and `blobatarUri()` are the stable public entries.
 */
export function blobatarSvg(
	name: string,
	className: string,
	live: boolean,
): { element: HTMLElement; stop: () => void } {
	const parts = _parts(name, { animate: "hover" });
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 100 100");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	for (const [property, value] of Object.entries(parts.vars ?? {})) svg.style.setProperty(property, value);
	if (parts.bg !== undefined) {
		const path = document.createElementNS(SVG_NAMESPACE, "path");
		path.setAttribute("d", parts.bg.d);
		path.setAttribute("fill", parts.bg.fill);
		svg.append(path);
	}
	const root = document.createElementNS(SVG_NAMESPACE, "g");
	root.setAttribute("class", parts.cls ?? "mo-root");
	root.innerHTML = parts.inner;
	svg.append(root);
	const element = document.createElement("span");
	element.className = className;
	element.append(svg);
	const driver = live ? gaze(svg, { target: "pointer" }) : undefined;
	return { element, stop: () => driver?.stop() };
}
