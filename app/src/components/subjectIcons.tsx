import {
  Atom, Binary, BookOpen, Brain, Calculator, ChartLine, Code, Cpu, Database, Dna, Earth, Feather, FlaskConical, GraduationCap, HeartPulse,
  Infinity as InfinityIcon, Landmark, Languages, Leaf, Magnet, Map, Microscope, Music, Orbit, Palette, PenTool, Pi, Radical, Rocket, Scale,
  Sigma, Stethoscope, Telescope, Zap, type LucideIcon,
} from 'lucide-react';

/** Icons a subject can wear, by the name stored in the database. */
export const SUBJECT_ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen, sigma: Sigma, radical: Radical, pi: Pi, infinity: InfinityIcon, calculator: Calculator, 'chart-line': ChartLine,
  atom: Atom, orbit: Orbit, magnet: Magnet, zap: Zap, rocket: Rocket, telescope: Telescope,
  flask: FlaskConical, microscope: Microscope, dna: Dna, leaf: Leaf, 'heart-pulse': HeartPulse, stethoscope: Stethoscope, brain: Brain,
  code: Code, cpu: Cpu, binary: Binary, database: Database,
  earth: Earth, map: Map, landmark: Landmark, scale: Scale, languages: Languages, feather: Feather, 'pen-tool': PenTool, palette: Palette, music: Music,
  'graduation-cap': GraduationCap,
};

/** Accent colours for subjects (the chart palette's categorical steps). */
export const SUBJECT_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767', '#6f8f9f'];

/** A reasonable icon from the subject's name, until the user picks one. */
export function guessIcon(name: string): string {
  const n = name.toLowerCase();
  const rules: [RegExp, string][] = [
    [/calc|analysis|integr|deriv/, 'sigma'], [/algebra|matri|linear/, 'radical'], [/stat|probab|data/, 'chart-line'], [/math|number|discrete/, 'pi'],
    [/quantum|atom|nuclear/, 'atom'], [/physic|mechanic|dynamic|kinemat/, 'orbit'], [/electr|circuit|magnet/, 'zap'], [/astro|space/, 'telescope'],
    [/chem/, 'flask'], [/bio|genet|cell/, 'dna'], [/ecolog|botan|environment/, 'leaf'], [/med|anatom|physiol/, 'heart-pulse'], [/psych|neuro/, 'brain'],
    [/program|comput|software|cs\b|algorithm/, 'code'], [/architect|hardware|system/, 'cpu'], [/database|sql/, 'database'],
    [/geo|earth/, 'earth'], [/histor/, 'landmark'], [/law|ethic|philos/, 'scale'], [/language|english|spanish|french|german|arabic|linguist/, 'languages'],
    [/liter|writing|poetry/, 'feather'], [/design|draw/, 'pen-tool'], [/art/, 'palette'], [/music/, 'music'],
  ];
  return rules.find(([re]) => re.test(n))?.[1] ?? 'book-open';
}

export function SubjectIcon({ icon, name, className }: { icon: string; name: string; className?: string }) {
  const Icon = SUBJECT_ICONS[icon] ?? SUBJECT_ICONS[guessIcon(name)] ?? BookOpen;
  return <Icon className={className} />;
}

/** Colour for a subject: its own, or a stable default from its id. */
export const subjectColor = (s: { id: number; color: string }) => s.color || SUBJECT_COLORS[s.id % SUBJECT_COLORS.length];
