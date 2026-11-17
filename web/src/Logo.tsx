/** ItaOS mark: a lowercase "i" whose dot is a yellow chat bubble (from the ita. wordmark). */
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ flex: "none", display: "block" }}>
      <rect width="64" height="64" rx="15" fill="#131a2a" />
      <rect x="26.5" y="27" width="11" height="26" rx="3" fill="#ffffff" />
      <circle cx="32" cy="16.5" r="7.5" fill="#f5c84c" />
      <path d="M26.6 21.2 L23.5 28.5 L32.8 23.8 Z" fill="#f5c84c" />
    </svg>
  );
}
