import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface Props {
  term: string // bold heading shown at the top of the popover
  children: ReactNode // the plain-language explanation body
}

// A small ⓘ marker that explains an app term (FSRS, leech, streak, …) in a styled
// popover. Hover to peek; click to pin it open (touch / read longer text), then Esc
// or an outside click dismisses it. The trigger stops its own click/pointer events so
// it never toggles an enclosing <label>'s control or triggers a parent card button.
export function InfoTip({ term, children }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!pinned) return
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) {
        setPinned(false)
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [pinned])

  return (
    // Hover lives on the WRAPPER (not the icon) so the cursor can travel onto the
    // popover — a DOM descendant — without the wrapper firing mouseleave. A
    // transparent ::before bridges the 6px gap so the trip never crosses a dead zone.
    <span
      className="infotip"
      ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned) setOpen(false)
      }}
    >
      <button
        type="button"
        className="infotip-icon"
        aria-label={`${term}とは`}
        aria-expanded={open}
        onClick={(e) => {
          // Inside a <label> a click would toggle the control; inside a card it would
          // start a session. Neither should happen — this only opens the explanation.
          e.preventDefault()
          e.stopPropagation()
          const next = !pinned
          setPinned(next)
          setOpen(next)
        }}
      >
        ⓘ
      </button>
      {open && (
        <span className="infotip-pop" role="tooltip">
          <span className="infotip-term">{term}</span>
          <span className="infotip-body">{children}</span>
        </span>
      )}
    </span>
  )
}
