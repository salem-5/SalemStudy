export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="228 300 568 450" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round">
        <path d="M512 372 C450 330 350 318 252 338 V690 C350 670 450 682 512 724 C574 682 674 670 772 690 V338 C674 318 574 330 512 372 Z" />
        <path d="M512 372 V724" />
        <path d="M580 446 L632 492 L580 538" stroke="var(--mid, #d7a266)" strokeWidth="32" />
      </g>
      <g stroke="currentColor" strokeOpacity="0.5" strokeWidth="26" strokeLinecap="round">
        <path d="M318 440 C360 432 400 434 446 446" />
        <path d="M318 512 C360 504 400 506 446 518" />
        <path d="M318 584 C350 578 376 579 404 584" />
      </g>
      <rect x="656" y="516" width="60" height="26" rx="4" fill="var(--mid, #d7a266)" />
    </svg>
  );
}
