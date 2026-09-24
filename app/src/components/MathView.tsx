import { memo, useMemo } from 'react';
import { previewExpr, renderable } from '../lib/render';

export const MathView = memo(function MathView({ expr, mathml, className }: { expr?: string; mathml?: string; className?: string }) {
  const html = useMemo(() => {
    if (mathml !== undefined) return renderable(mathml);
    return previewExpr(expr ?? '').html;
  }, [expr, mathml]);
  if (!html) return <span className={`${className ?? ''} muted`}>∅</span>;
  return <span className={`math ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
});
