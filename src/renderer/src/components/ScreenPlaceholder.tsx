interface ScreenPlaceholderProps {
  title: string
  description: string
}

/**
 * Shared shell for screens that don't have real content yet (Phase 1
 * steps 4+ fill these in one at a time). Keeping this as one component
 * means every screen looks consistent until it's built out.
 */
function ScreenPlaceholder({ title, description }: ScreenPlaceholderProps): React.JSX.Element {
  return (
    <section className="screen-placeholder">
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  )
}

export default ScreenPlaceholder
