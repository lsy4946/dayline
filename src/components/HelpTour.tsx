import {
  Check,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  X,
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

export interface HelpTourStep {
  target?: string
  eyebrow: string
  title: string
  description: string
  tips?: string[]
  example?: ReactNode
}

interface HighlightRect {
  top: number
  left: number
  width: number
  height: number
}

interface CardPosition {
  top: number
  left: number
}

const GAP = 18
const EDGE = 14
const ESTIMATED_CARD_HEIGHT = 290

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function getCardPosition(rect: HighlightRect | null): CardPosition {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const cardWidth = Math.min(360, viewportWidth - EDGE * 2)

  if (!rect) {
    return {
      top: Math.max(EDGE, (viewportHeight - ESTIMATED_CARD_HEIGHT) / 2),
      left: Math.max(EDGE, (viewportWidth - cardWidth) / 2),
    }
  }

  const spaces = {
    right: viewportWidth - rect.left - rect.width,
    left: rect.left,
    bottom: viewportHeight - rect.top - rect.height,
    top: rect.top,
  }
  const horizontalFits = cardWidth + GAP
  const verticalFits = ESTIMATED_CARD_HEIGHT + GAP

  if (spaces.right >= horizontalFits) {
    return {
      top: clamp(rect.top + rect.height / 2 - ESTIMATED_CARD_HEIGHT / 2, EDGE, viewportHeight - ESTIMATED_CARD_HEIGHT - EDGE),
      left: rect.left + rect.width + GAP,
    }
  }
  if (spaces.left >= horizontalFits) {
    return {
      top: clamp(rect.top + rect.height / 2 - ESTIMATED_CARD_HEIGHT / 2, EDGE, viewportHeight - ESTIMATED_CARD_HEIGHT - EDGE),
      left: rect.left - cardWidth - GAP,
    }
  }
  if (spaces.bottom >= verticalFits || spaces.bottom >= spaces.top) {
    return {
      top: clamp(rect.top + rect.height + GAP, EDGE, viewportHeight - ESTIMATED_CARD_HEIGHT - EDGE),
      left: clamp(rect.left + rect.width / 2 - cardWidth / 2, EDGE, viewportWidth - cardWidth - EDGE),
    }
  }
  return {
    top: clamp(rect.top - ESTIMATED_CARD_HEIGHT - GAP, EDGE, viewportHeight - ESTIMATED_CARD_HEIGHT - EDGE),
    left: clamp(rect.left + rect.width / 2 - cardWidth / 2, EDGE, viewportWidth - cardWidth - EDGE),
  }
}

export function HelpTour({
  id,
  open,
  steps,
  onClose,
}: {
  id: string
  open: boolean
  steps: HelpTourStep[]
  onClose: () => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [highlight, setHighlight] = useState<HighlightRect | null>(null)
  const [cardPosition, setCardPosition] = useState<CardPosition>({ top: EDGE, left: EDGE })
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const step = steps[stepIndex]

  useEffect(() => {
    if (!open) return
    setStepIndex(0)
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const layer = dialogRef.current?.closest<HTMLElement>('.help-tour')
    const backgroundElements = layer?.parentElement
      ? Array.from(layer.parentElement.children)
          .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer)
          .map((element) => ({
            element,
            inert: element.inert,
            ariaHidden: element.getAttribute('aria-hidden'),
          }))
      : []
    backgroundElements.forEach(({ element }) => {
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    })
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 30)
    return () => {
      window.clearTimeout(timer)
      backgroundElements.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      })
      previousFocusRef.current?.focus()
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !step) return

    const updatePosition = () => {
      const target = step.target
        ? document.querySelector<HTMLElement>(`[data-help-id="${step.target}"]`)
        : null
      if (!target) {
        setHighlight(null)
        setCardPosition(getCardPosition(null))
        return
      }

      const bounds = target.getBoundingClientRect()
      const padding = window.innerWidth < 500 ? 4 : 7
      const rect = {
        top: Math.max(4, bounds.top - padding),
        left: Math.max(4, bounds.left - padding),
        width: Math.min(window.innerWidth - 8, bounds.width + padding * 2),
        height: Math.min(window.innerHeight - 8, bounds.height + padding * 2),
      }
      setHighlight(rect)
      setCardPosition(getCardPosition(rect))
    }

    updatePosition()
    const delayedUpdate = window.setTimeout(updatePosition, 180)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.clearTimeout(delayedUpdate)
      window.removeEventListener('resize', updatePosition)
    }
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (stepIndex === steps.length - 1) onClose()
        else setStepIndex((current) => current + 1)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setStepIndex((current) => Math.max(0, current - 1))
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'),
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open, stepIndex, steps.length])

  if (!open || !step) return null

  const highlightStyle = highlight
    ? ({
        top: highlight.top,
        left: highlight.left,
        width: highlight.width,
        height: highlight.height,
      } satisfies CSSProperties)
    : undefined

  return (
    <div className={`help-tour ${highlight ? 'has-highlight' : 'is-centered'}`}>
      <div className="help-tour-blocker" aria-hidden="true" />
      {highlight && <div className="help-tour-spotlight" style={highlightStyle} aria-hidden="true" />}
      <section
        id={id}
        ref={dialogRef}
        className="help-tour-card"
        style={{ top: cardPosition.top, left: cardPosition.left }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-tour-title"
        aria-describedby="help-tour-description"
        tabIndex={-1}
      >
        <header className="help-tour-header">
          <div>
            <span className="help-tour-eyebrow">{step.eyebrow}</span>
            <span className="help-tour-count">{stepIndex + 1} / {steps.length}</span>
          </div>
          <button type="button" className="help-tour-close" onClick={onClose} aria-label="도움말 닫기">
            <X size={17} />
          </button>
        </header>

        <div className="help-tour-progress" aria-hidden="true">
          {steps.map((item, index) => (
            <span key={`${item.eyebrow}-${index}`} className={index <= stepIndex ? 'is-complete' : ''} />
          ))}
        </div>

        <div className="help-tour-copy">
          <h2 id="help-tour-title">{step.title}</h2>
          <p id="help-tour-description">{step.description}</p>
        </div>

        {step.example && <div className="help-tour-example">{step.example}</div>}

        {step.tips && step.tips.length > 0 && (
          <ul className="help-tour-tips">
            {step.tips.map((tip) => (
              <li key={tip}><Lightbulb size={13} /> <span>{tip}</span></li>
            ))}
          </ul>
        )}

        <footer className="help-tour-footer">
          <button
            type="button"
            className="help-tour-back"
            onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
            disabled={stepIndex === 0}
          >
            <ChevronLeft size={16} /> 이전
          </button>
          <span className="help-tour-key-hint">← → 키로 이동</span>
          <button
            type="button"
            className="help-tour-next"
            onClick={() => {
              if (stepIndex === steps.length - 1) onClose()
              else setStepIndex((current) => current + 1)
            }}
          >
            {stepIndex === steps.length - 1 ? (
              <><Check size={16} /> 시작하기</>
            ) : (
              <>다음 <ChevronRight size={16} /></>
            )}
          </button>
        </footer>
      </section>
    </div>
  )
}
