/**
 * Minimal CommonMark subset used by Astra's gate documents: headings, paragraphs, fenced code,
 * lists, tables, blockquotes, rules, and the inline span syntax. Every text run is escaped before
 * it is wrapped, and link targets are restricted, so the output is safe to assign as innerHTML.
 *
 * This is deliberately not a general markdown engine — it renders what the gate prompts emit.
 */
const SAFE_LINK = /^(https?:\/\/|mailto:|#|\.{0,2}\/)/i;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Inline spans are resolved on already-escaped text, so no raw markup can survive. */
export function renderInline(raw) {
  let html = escapeHtml(raw);
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const target = href.replaceAll("&amp;", "&");
    if (!SAFE_LINK.test(target)) return label;
    return `<a href="${escapeHtml(target)}" rel="noreferrer noopener" target="_blank">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)!?]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return html;
}

function tableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isTableDivider = (line) => /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(line) && line.includes("-");

export function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const out = [];
  let index = 0;

  const paragraph = (buffer) => {
    if (buffer.length) out.push(`<p>${renderInline(buffer.join(" "))}</p>`);
    buffer.length = 0;
  };
  const pending = [];

  while (index < lines.length) {
    const line = lines[index];

    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      paragraph(pending);
      const marker = fence[1];
      const language = fence[2].trim().split(/\s+/)[0] ?? "";
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      const attribute = language ? ` data-language="${escapeHtml(language)}"` : "";
      out.push(`<pre${attribute}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      paragraph(pending);
      const level = Math.min(6, heading[1].length + 1); // h1 is the page title, so shift down one.
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      paragraph(pending);
      out.push("<hr />");
      index += 1;
      continue;
    }

    if (line.trim().startsWith("|") && isTableDivider(lines[index + 1] ?? "")) {
      paragraph(pending);
      const headers = tableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(tableRow(lines[index]));
        index += 1;
      }
      const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
        .join("");
      // Wrapped so a wide table scrolls inside its card instead of crushing its columns.
      out.push(
        `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      paragraph(pending);
      const tag = bullet ? "ul" : "ol";
      const items = [];
      while (index < lines.length) {
        const item = bullet ? /^\s*[-*+]\s+(.*)$/.exec(lines[index]) : /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]);
        if (!item) break;
        items.push(`<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      paragraph(pending);
      const quoted = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${markdownToHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      paragraph(pending);
      index += 1;
      continue;
    }

    pending.push(line.trim());
    index += 1;
  }

  paragraph(pending);
  return out.join("\n");
}
