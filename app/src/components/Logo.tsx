/** The app mark: a neon radical over x, matching the application icon. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 512 512" aria-hidden>
      <defs>
        <linearGradient id="logo-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2f8bff" />
          <stop offset="0.55" stopColor="#3ad7ff" />
          <stop offset="1" stopColor="#6cf5e4" />
        </linearGradient>
        <radialGradient id="logo-bg" cx="0.5" cy="0.32" r="0.95">
          <stop offset="0" stopColor="#0c141a" />
          <stop offset="1" stopColor="#000000" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx="108" fill="url(#logo-bg)" />
      <rect x="4" y="4" width="504" height="504" rx="104" fill="none" stroke="url(#logo-grad)" strokeOpacity="0.22" strokeWidth="4" />
      <g fill="none" stroke="url(#logo-grad)" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round">
        <path d="M96 288 H150 L196 382 L292 142 H432" />
        <path d="M320 226 L400 326" />
        <path d="M400 226 L320 326" />
      </g>
    </svg>
  );
}
