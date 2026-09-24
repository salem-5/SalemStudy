import type { CSSProperties } from 'react';

export function Skel({ w, h, className, style }: { w?: string | number; h?: number; className?: string; style?: CSSProperties }) {
  return <div className={`skel${className ? ` ${className}` : ''}`} style={{ width: w, height: h, ...style }} />;
}

export function AssignmentListSkeleton() {
  return (
    <div className="skel-list" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skel-asg">
          <Skel w={`${58 + ((i * 19) % 34)}%`} h={12} />
          <Skel w="44%" h={9} />
          <Skel w="100%" h={3} />
        </div>
      ))}
    </div>
  );
}

export function QuestionSkeleton() {
  return (
    <div className="question skel-q" aria-hidden>
      <div className="question-head">
        <Skel w={62} h={26} />
        <Skel w={150} h={12} />
        <span className="spacer" />
        <Skel w={90} h={14} />
      </div>
      <div className="skel-frame">
        <Skel w="92%" h={14} />
        <Skel w="78%" h={14} />
        <Skel w="54%" h={14} />
      </div>
      <div className="boxes">
        {[0, 1].map((i) => (
          <div key={i} className="box skel-box">
            <div className="box-head">
              <Skel w={30} h={12} />
              <Skel w={54} h={11} />
              <span className="spacer" />
              <Skel w={70} h={11} />
            </div>
            <div className="box-body"><Skel w="100%" h={38} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
