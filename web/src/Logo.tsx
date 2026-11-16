/** GrowthOS mark: a G with a growth line breaking out through its opening. */
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ flex: "none", display: "block" }}>
      <rect width="64" height="64" rx="15" fill="#0f1a16" />
      <path d="M42.9 18.7 A20 20 0 1 0 50 34 L41 34" fill="none" stroke="#ffffff" strokeWidth="7.5" strokeLinecap="round" />
      <path d="M22 43.5 L28.5 37 L33.5 42 L55 13" fill="none" stroke="#0f1a16" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22 43.5 L28.5 37 L33.5 42 L55 13" fill="none" stroke="#35d39a" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M44.5 13.5 L55.5 12.5 L56.5 23.5" fill="none" stroke="#35d39a" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
