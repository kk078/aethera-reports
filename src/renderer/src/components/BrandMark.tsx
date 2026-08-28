interface BrandMarkProps {
  size?: number
}

/**
 * The sidebar's inline rendering of the app icon's mark (build/icon.svg)
 * — same three-bar silhouette, same teal field + gold "value" bar, sized
 * for UI chrome instead of a taskbar/installer. Kept as one small
 * component (not an imported image asset) so it's crisp at any size and
 * never needs its own icon-generation step.
 */
function BrandMark({ size = 22 }: BrandMarkProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" role="img" aria-label="Aethera Reports">
      <rect width="512" height="512" rx="112" fill="#0e7d74" />
      <rect x="81" y="250" width="90" height="130" rx="18" fill="#f6f4ec" />
      <rect x="211" y="170" width="90" height="210" rx="18" fill="#f6f4ec" />
      <rect x="341" y="90" width="90" height="290" rx="18" fill="#e3ae55" />
    </svg>
  )
}

export default BrandMark
