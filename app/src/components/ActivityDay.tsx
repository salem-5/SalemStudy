import { useEffect, useState } from 'react';
import { BookOpen, FileText, Layers, ListChecks, MessageSquare, Timer } from 'lucide-react';
import { Modal } from './Dialogs';
import { studyApi, type ActivityEntry } from '../study/api';

const ICONS = {
  card: Layers, quiz: ListChecks, chat: MessageSquare, note: FileText, source: BookOpen, focus: Timer,
} as const;

const NAMES = {
  card: 'flashcards', quiz: 'quizzes', chat: 'questions asked', note: 'notes', source: 'sources added', focus: 'focus sessions',
} as const;

export function ActivityDay({ day, onClose, onOpenNotebook }: {
  day: number;
  onClose: () => void;
  onOpenNotebook?: (notebookId: number) => void;
}) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    studyApi.activityDetail(day, day + 864e5)
      .then((rows) => { if (alive) setEntries(rows); })
      .catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [day]);

  const date = new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const bySubject = new Map<string, Map<string, { id: number | null; counts: Map<ActivityEntry['kind'], number> }>>();
  for (const entry of entries ?? []) {
    const subject = entry.subject ?? 'Not in a notebook';
    const notebook = entry.notebook ?? '-';
    const notebooks = bySubject.get(subject) ?? new Map();
    const slot = notebooks.get(notebook) ?? { id: entry.notebookId, counts: new Map() };
    slot.counts.set(entry.kind, (slot.counts.get(entry.kind) ?? 0) + 1);
    notebooks.set(notebook, slot);
    bySubject.set(subject, notebooks);
  }

  return (
    <Modal title={date} onClose={onClose}>
      {entries === null && <p className="muted small">Looking…</p>}
      {entries?.length === 0 && <p className="muted small">Nothing recorded for this day.</p>}
      {!!entries?.length && (
        <div className="activity-day">
          {[...bySubject.entries()].map(([subject, notebooks]) => (
            <div key={subject} className="activity-subject">
              <div className="panel-title">{subject}</div>
              {[...notebooks.entries()].map(([notebook, slot]) => (
                <div key={notebook} className="activity-notebook">
                  {slot.id !== null && onOpenNotebook ? (
                    <button type="button" className="link activity-notebook-name"
                      onClick={() => { onOpenNotebook(slot.id!); onClose(); }}>{notebook}</button>
                  ) : <span className="activity-notebook-name muted">{notebook}</span>}
                  <div className="activity-counts">
                    {[...slot.counts.entries()].map(([kind, n]) => {
                      const Icon = ICONS[kind];
                      return (
                        <span key={kind} className="activity-count" title={`${n} ${NAMES[kind]}`}>
                          <Icon />{n}
                        </span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
