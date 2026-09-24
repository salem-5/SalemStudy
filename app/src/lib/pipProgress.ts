export type Step = { stage: string; file: string | null; files: number; done: number; total: number; installing: boolean };

const packageOf = (wheel: string) => wheel.replace(/^.*\//, '').replace(/-\d.*$/, '').replace(/_/g, '-');

export function readPipLine(step: Step, line: string): Step {
  const t = line.trim();
  const downloading = /^Downloading\s+(\S+)/.exec(t);
  if (downloading) return { ...step, file: packageOf(downloading[1]), files: step.files + 1, done: 0, total: 0, installing: false };
  const progress = /^Progress\s+(\d+)\s+of\s+(\d+)/.exec(t);
  if (progress) return { ...step, done: Number(progress[1]), total: Number(progress[2]) };
  if (/^Installing collected packages/.test(t)) return { ...step, stage: 'Installing…', file: null, installing: true };
  if (/^Successfully installed/.test(t)) return { ...step, stage: 'Finishing…', file: null, installing: true };
  return step;
}
