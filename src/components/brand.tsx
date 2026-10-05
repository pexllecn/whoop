export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#232321" stroke="rgb(255 255 255 / 0.12)" />
      <path
        d="M5 17h5l2.5-6 4 12 3-9 1.8 3H27"
        fill="none"
        stroke="#3987e5"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
