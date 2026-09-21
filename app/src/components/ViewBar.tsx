import { createContext, useContext } from 'react';
import { PomodoroChip } from './Pomodoro';

/** How the top bars reach the Focus view without threading props everywhere. */
export const OpenFocus = createContext<() => void>(() => {});

/** The 48px bar on top of every Study, Chat and Focus view. */
export function ViewBar({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  const openFocus = useContext(OpenFocus);
  return (
    <header className="viewbar">
      <div className="viewbar-title">{children}</div>
      <span className="spacer" />
      {actions}
      <PomodoroChip onOpen={openFocus} />
    </header>
  );
}

export function TopbarChip() {
  const openFocus = useContext(OpenFocus);
  return <PomodoroChip onOpen={openFocus} />;
}
