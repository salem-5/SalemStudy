import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import latex from 'highlight.js/lib/languages/latex';
import markdown from 'highlight.js/lib/languages/markdown';
import matlab from 'highlight.js/lib/languages/matlab';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** Syntax highlighting for code in chats, notes and the Python tool card. */

const LANGS = {
  bash, c, cpp, csharp, css, go, java, javascript, json, kotlin, latex, markdown, matlab, plaintext, python, r, rust, shell, sql, swift, typescript, xml, yaml,
};
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'zsh', 'console'], { languageName: 'bash' });
hljs.registerAliases(['tex'], { languageName: 'latex' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['c++', 'h', 'hpp'], { languageName: 'cpp' });
hljs.registerAliases(['cs'], { languageName: 'csharp' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });

const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/** Highlighted HTML for `code`; an unknown or missing language is guessed, briefly. */
export function highlight(code: string, lang?: string | null): { html: string; lang: string } {
  const name = (lang ?? '').trim().toLowerCase().split(/\s+/)[0];
  try {
    if (name && hljs.getLanguage(name)) return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, lang: name };
    if (code.length < 20_000) {
      const auto = hljs.highlightAuto(code, ['python', 'javascript', 'typescript', 'bash', 'json', 'cpp', 'java', 'rust', 'sql', 'latex', 'matlab']);
      if (auto.relevance > 4 && auto.language) return { html: auto.value, lang: auto.language };
    }
  } catch { /* fall through to plain text */ }
  return { html: escapeHtml(code), lang: name || 'text' };
}
