import { Check, Loader2, Square, X } from 'lucide-react';
import { Modal } from './Dialogs';
import { dismissTask, stopTask, type BackgroundTask } from '../lib/salem/tasks';
import { formatCost } from '../lib/meter';

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

export function TaskProgress({ task, onClose }: { task: BackgroundTask; onClose: () => void }) {
  const over = ['completed', 'failed', 'cancelled'].includes(task.state);
  const elapsed = (task.finishedAt ?? Date.now()) - task.startedAt;

  return (
    <Modal title={task.label} onClose={onClose}>
      <div className="task-detail">
        <div className={`task-detail-head ${task.state}`}>
          <span className="task-detail-icon">
            {task.state === 'completed' ? <Check />
              : task.state === 'failed' || task.state === 'cancelled' ? <X />
                : <Loader2 className="spin" />}
          </span>
          <span className="task-detail-now">
            {task.state === 'failed' ? (task.error ?? 'It failed')
              : task.state === 'cancelled' ? 'Stopped'
                : task.detail || 'Starting…'}
          </span>
          <span className="task-detail-time muted">
            {task.cost > 0 && <span className="task-detail-cost" title="What its model calls have cost so far">{formatCost(task.cost)} · </span>}
            {clock(elapsed)}
          </span>
        </div>

        {task.log.length > 0 && (
          <ol className="task-steps">
            {task.log.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className={i === task.log.length - 1 && !over ? 'now' : undefined}>
                <span className="task-step-at muted">+{clock(entry.at - task.startedAt)}</span>
                <span className="task-step-text">{entry.text}</span>
              </li>
            ))}
          </ol>
        )}
        {!task.log.length && <p className="muted small">It has not reported a step yet.</p>}

        <div className="modal-actions">
          {over ? (
            <button type="button" className="btn" onClick={() => { dismissTask(task.id); onClose(); }}>Dismiss</button>
          ) : (
            <button type="button" className="btn" onClick={() => { stopTask(task.id); onClose(); }}><Square />Stop it</button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
