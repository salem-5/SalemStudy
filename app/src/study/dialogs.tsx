import { useState } from 'react';
import { Modal } from '../components/Dialogs';

export function NameDialog({ title, label, initial = '', withDescription, initialDescription = '', submitLabel, onSubmit, onClose }: {
  title: string;
  label: string;
  initial?: string;
  withDescription?: boolean;
  initialDescription?: string;
  submitLabel: string;
  onSubmit: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(name.trim(), description.trim());
      onClose();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{label}</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        {withDescription && (
          <label className="field">
            <span>Description <i className="muted">optional</i></span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        )}
        {error && <div className="form-err">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onClose }: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-text">{children}</div>
      {error && <div className="form-err">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onConfirm(); onClose(); } catch (e) { setError(String(e)); setBusy(false); }
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
