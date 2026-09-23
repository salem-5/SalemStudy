import { BookOpen, FileText, Layers, ListChecks, MessageSquare } from 'lucide-react';
import type { Reference } from '../lib/reference';

/**
 * What the chat has been handed, sitting where an attachment sits.
 *
 * Just the name. Spelling the whole quotation out took up the top of the
 * sheet with something the student had just been reading; hovering gives it
 * back when they want to check exactly what went across.
 */

const ICON = {
  note: FileText,
  quiz: ListChecks,
  card: Layers,
  source: BookOpen,
  chat: MessageSquare,
} as const;

export function ReferenceChips({ references, className }: { references: Reference[]; className?: string }) {
  if (!references.length) return null;
  return (
    <div className={`ref-chips${className ? ` ${className}` : ''}`}>
      {references.map((ref) => {
        const Icon = ICON[ref.kind];
        return (
          <span key={ref.id} className="ref-chip" tabIndex={0}>
            <span className="ref-chip-icon"><Icon /></span>
            <span className="ref-chip-label">{ref.label}</span>
            <span className="ref-peek" role="tooltip">
              <span className="ref-peek-head">{ref.label}{ref.detail ? ` · ${ref.detail}` : ''}</span>
              {ref.excerpt && <span className="ref-peek-quote">“{ref.excerpt}”</span>}
              <span className="ref-peek-note">
                {ref.briefed
                  ? 'This chat was opened about it — the assistant has it in full.'
                  : ref.content
                    ? `${ref.content.title} — sent with your message, in full.`
                    : 'Sent with your message.'}
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
}
