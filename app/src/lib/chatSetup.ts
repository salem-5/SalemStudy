import { getAiConfig, type AiConfig } from './ai';
import { pythonStatus, runPython, sandboxName } from './python';

/**
 * What a chat view needs to know before it can take a message: the AI
 * settings, and whether the Python sandbox is up.
 *
 * Answering a message is the Salem runtime's job (see `lib/salem`); this is
 * only the setup and the file reading around it.
 */

export type ChatSetup = { config: AiConfig; python: boolean };

export async function chatSetup(): Promise<ChatSetup> {
  const config = await getAiConfig();
  let python = false;
  if (config.pythonEnabled) {
    try { python = (await pythonStatus()).ready; } catch { python = false; }
  }
  return { config, python };
}

/** Readable text out of an uploaded file, where there is one. */
export async function extractText(file: File, attachmentId: number, python: boolean): Promise<string | null> {
  const name = file.name.toLowerCase();
  const textual = file.type.startsWith('text/') || /\.(md|markdown|txt|tex|csv|tsv|json|py|js|ts|rs|c|cpp|h|java|m|r|sql|yaml|yml|xml|html|css)$/.test(name);
  if (textual) return (await file.text()).slice(0, 400_000);
  if ((file.type === 'application/pdf' || name.endsWith('.pdf')) && python) {
    const safe = sandboxName(file.name);
    const code = `doc = pymupdf.open(${JSON.stringify(safe)})\nfor i, page in enumerate(doc):\n    if i >= 60: break\n    print(f"--- page {i + 1} ---")\n    print(page.get_text())`;
    try {
      const r = await runPython(code, 60, [attachmentId]);
      return r.ok && r.stdout.trim() ? r.stdout : null;
    } catch {
      return null;
    }
  }
  return null;
}
