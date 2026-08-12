const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function waitForLoad(window) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.webContents.removeListener('did-finish-load', onFinish)
      window.webContents.removeListener('did-fail-load', onFail)
    }
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const onFail = (_event, code, description) => {
      cleanup()
      reject(new Error(`Renderer failed to load (${code}): ${description}`))
    }
    window.webContents.once('did-finish-load', onFinish)
    window.webContents.once('did-fail-load', onFail)
  })
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function destroyQaWindow(window) {
  if (!window || window.isDestroyed()) return
  try {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
  } catch {
    // Best-effort cleanup after a renderer/debugger failure.
  }
  window.destroy()
}

function runIn(window, expression) {
  return window.webContents.executeJavaScript(expression).catch((error) => {
    const preview = String(expression).replace(/\s+/g, ' ').slice(0, 220)
    throw new Error(`Renderer expression failed: ${preview}. ${error.message}`)
  })
}

async function waitForRenderer(window, expression, label, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await runIn(window, expression)
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(25)
  }
  const detail = lastError ? ` Last renderer error: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}.${detail}`)
}

async function installQaHelpers(window) {
  await window.webContents.insertCSS(`
    * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  `)
  await runIn(window, `
    (() => {
      const setNativeValue = (element, value) => {
        if (!element) return false
        const previousValue = element.value
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        setter?.call(element, value)
        element._valueTracker?.setValue(previousValue)
        element.dispatchEvent(new Event(
          element instanceof HTMLSelectElement ? 'change' : 'input',
          { bubbles: true },
        ))
        if (!(element instanceof HTMLSelectElement)) {
          element.dispatchEvent(new Event('change', { bubbles: true }))
        }
        return true
      }
      window.__daylineQa = {
        setValue: (selector, value) => setNativeValue(document.querySelector(selector), value),
        blur: (selector) => {
          const element = document.querySelector(selector)
          element?.focus()
          element?.blur()
          return Boolean(element)
        },
        key: (selector, key, options = {}) => {
          const element = document.querySelector(selector)
          if (!element) return false
          element.focus()
          element.dispatchEvent(new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            ...options,
          }))
          return true
        },
        dragAndDrop: (sourceSelector, targetSelector) => {
          const source = document.querySelector(sourceSelector)
          const target = document.querySelector(targetSelector)
          if (!source || !target) return false
          const dataTransfer = new DataTransfer()
          const sourceBounds = source.getBoundingClientRect()
          const targetBounds = target.getBoundingClientRect()
          const sourceX = sourceBounds.left + sourceBounds.width / 2
          const sourceY = sourceBounds.top + sourceBounds.height / 2
          const clientX = targetBounds.left + targetBounds.width / 2
          const clientY = targetBounds.top + targetBounds.height / 2
          source.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: sourceX, clientY: sourceY,
          }))
          target.dispatchEvent(new DragEvent('dragenter', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          target.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          target.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          source.dispatchEvent(new DragEvent('dragend', {
            bubbles: true, cancelable: true, dataTransfer,
          }))
          return true
        },
        dragTaskDate: (taskId, sourceDate, targetDate, targetTaskId = null) => {
          const sourceSegment = [...document.querySelectorAll(
            '[data-qa="calendar-task-segment"][data-task-id="' + CSS.escape(taskId) + '"]',
          )].find((segment) => segment.dataset.segmentStart <= sourceDate
            && segment.dataset.segmentEnd >= sourceDate)
          const source = sourceSegment?.querySelector('[data-qa="calendar-task-date-drag"]')
          const sourceCell = document.querySelector(
            '[data-calendar-drop-target][data-date="' + CSS.escape(sourceDate) + '"]',
          )
          const targetCell = document.querySelector(
            '[data-calendar-drop-target][data-date="' + CSS.escape(targetDate) + '"]',
          )
          const targetSegment = targetTaskId
            ? [...document.querySelectorAll(
              '[data-qa="calendar-task-segment"][data-task-id="' + CSS.escape(targetTaskId) + '"]',
            )].find((segment) => segment.dataset.segmentStart <= targetDate
              && segment.dataset.segmentEnd >= targetDate)
            : null
          const target = targetSegment || targetCell
          if (!source || !sourceCell || !targetCell || !target) return null
          const sourceBounds = source.getBoundingClientRect()
          const sourceCellBounds = sourceCell.getBoundingClientRect()
          const targetBounds = target.getBoundingClientRect()
          const targetCellBounds = targetCell.getBoundingClientRect()
          const start = {
            x: sourceCellBounds.left + sourceCellBounds.width / 2,
            y: sourceBounds.top + sourceBounds.height / 2,
          }
          const finish = {
            x: targetCellBounds.left + targetCellBounds.width / 2,
            y: targetSegment
              ? targetBounds.top + targetBounds.height / 2
              : targetCellBounds.top + targetCellBounds.height / 2,
          }
          const dataTransfer = new DataTransfer()
          source.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: start.x, clientY: start.y,
          }))
          target.dispatchEvent(new DragEvent('dragenter', {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: finish.x, clientY: finish.y,
          }))
          target.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: finish.x, clientY: finish.y,
          }))
          target.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: finish.x, clientY: finish.y,
          }))
          source.dispatchEvent(new DragEvent('dragend', {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: finish.x, clientY: finish.y,
          }))
          return {
            taskId,
            sourceDate,
            targetDate,
            targetTaskId,
            types: [...dataTransfer.types],
            sourceHitTaskId: document.elementFromPoint(start.x, start.y)
              ?.closest('[data-task-id]')?.dataset.taskId ?? null,
            targetHitDate: document.elementFromPoint(finish.x, finish.y)
              ?.closest('[data-date]')?.dataset.date ?? targetDate,
          }
        },
        dragTemplateToCalendarHit: async (templateId, date) => {
          const card = document.querySelector(
            '[data-template-id="' + CSS.escape(templateId) + '"]',
          )
          const source = card?.querySelector('[data-qa="template-calendar-drag-source"]')
          const cell = document.querySelector(
            '[data-calendar-drop-target][data-date="' + CSS.escape(date) + '"]',
          )
          const panel = document.querySelector('[data-qa="template-panel"]')
          const calendar = document.querySelector('.calendar-workspace')
          if (!source || !cell || !panel || !calendar) return null
          const sourceBounds = source.getBoundingClientRect()
          const cellBounds = cell.getBoundingClientRect()
          const dataTransfer = new DataTransfer()
          source.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: sourceBounds.left + sourceBounds.width / 2,
            clientY: sourceBounds.top + sourceBounds.height / 2,
          }))
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          await new Promise((resolve) => setTimeout(resolve, 180))
          const clientX = cellBounds.left + cellBounds.width / 2
          const clientY = cellBounds.top + cellBounds.height / 2
          const hit = document.elementFromPoint(clientX, clientY)
          const panelBounds = panel.getBoundingClientRect()
          const calendarBounds = calendar.getBoundingClientRect()
          const beforeDrop = {
            dragging: panel.dataset.calendarDragging,
            pointerEvents: getComputedStyle(panel).pointerEvents,
            panelRight: panelBounds.right,
            calendarLeft: calendarBounds.left,
            hitDate: hit?.closest('[data-date]')?.dataset.date ?? null,
            hitInsidePanel: panel.contains(hit),
            types: [...dataTransfer.types],
          }
          hit?.dispatchEvent(new DragEvent('dragenter', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          hit?.dispatchEvent(new DragEvent('dragover', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          hit?.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          source.dispatchEvent(new DragEvent('dragend', {
            bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
          }))
          await new Promise((resolve) => requestAnimationFrame(resolve))
          return {
            ...beforeDrop,
            draggingAfter: panel.dataset.calendarDragging ?? null,
          }
        },
        selectRange: (firstDate, secondDate) => {
          const first = document.querySelector('[data-date="' + firstDate + '"]')
          const second = document.querySelector('[data-date="' + secondDate + '"]')
          if (!first || !second) return false
          const firstRect = first.getBoundingClientRect()
          const secondRect = second.getBoundingClientRect()
          const common = {
            bubbles: true,
            cancelable: true,
            pointerId: 91,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: 1,
          }
          first.dispatchEvent(new PointerEvent('pointerdown', {
            ...common, clientX: firstRect.left + 8, clientY: firstRect.top + 8,
          }))
          second.dispatchEvent(new PointerEvent('pointerover', {
            ...common, clientX: secondRect.left + 8, clientY: secondRect.top + 8,
          }))
          second.dispatchEvent(new PointerEvent('pointerenter', {
            ...common, bubbles: false, clientX: secondRect.left + 8, clientY: secondRect.top + 8,
          }))
          window.dispatchEvent(new PointerEvent('pointerup', {
            ...common, buttons: 0, clientX: secondRect.left + 8, clientY: secondRect.top + 8,
          }))
          return true
        },
        selectRangeAcrossBar: (firstDate, secondDate, segmentSelector) => {
          const first = document.querySelector(
            '[data-calendar-drop-target][data-date="' + CSS.escape(firstDate) + '"]',
          )
          const second = document.querySelector(
            '[data-calendar-drop-target][data-date="' + CSS.escape(secondDate) + '"]',
          )
          const segment = document.querySelector(segmentSelector)
          if (!first || !second || !segment) return null
          const firstRect = first.getBoundingClientRect()
          const secondRect = second.getBoundingClientRect()
          const segmentRect = segment.getBoundingClientRect()
          const start = {
            x: firstRect.left + firstRect.width / 2,
            y: firstRect.top + 8,
          }
          const finish = {
            x: secondRect.left + secondRect.width / 2,
            y: segmentRect.top + segmentRect.height / 2,
          }
          const common = {
            bubbles: true,
            cancelable: true,
            pointerId: 292,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
          }
          first.dispatchEvent(new PointerEvent('pointerdown', {
            ...common, buttons: 1, clientX: start.x, clientY: start.y,
          }))
          segment.dispatchEvent(new PointerEvent('pointermove', {
            ...common, buttons: 1, clientX: finish.x, clientY: finish.y,
          }))
          window.dispatchEvent(new PointerEvent('pointerup', {
            ...common, buttons: 0, clientX: finish.x, clientY: finish.y,
          }))
          return {
            firstDate,
            secondDate,
            targetTaskId: document.elementFromPoint(finish.x, finish.y)
              ?.closest('[data-task-id]')?.dataset.taskId ?? null,
          }
        },
        scheduleIds: () => [...document.querySelectorAll(
          '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
        )].map((row) => row.dataset.taskId),
        calendarSegmentsForDate: (date) => [...document.querySelectorAll(
          '[data-qa="calendar-task-layout"] .calendar-task-segment[data-task-id]',
        )].filter((segment) => segment.dataset.segmentStart <= date
          && segment.dataset.segmentEnd >= date),
        clickButtonText: (scopeSelector, text) => {
          const scope = scopeSelector ? document.querySelector(scopeSelector) : document
          const button = [...(scope?.querySelectorAll('button') ?? [])]
            .find((candidate) => candidate.textContent?.trim().includes(text))
          button?.click()
          return Boolean(button)
        },
        contextMenu: (element) => {
          if (!element) return false
          element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
          return true
        },
      }
      return true
    })()
  `)
}

async function reloadRenderer(window) {
  const loaded = waitForLoad(window)
  window.webContents.reload()
  await loaded
  await installQaHelpers(window)
}

async function loadRendererForQaDate(window, rendererPath, mode, qaDate) {
  const loaded = waitForLoad(window)
  await Promise.all([
    window.loadFile(rendererPath, { query: { mode, qaDate } }),
    loaded,
  ])
  await installQaHelpers(window)
}

async function dragSplitter(window, selector, targetPercent) {
  const wasVisible = window.isVisible()
  if (!wasVisible) {
    window.showInactive()
    await sleep(40)
  }
  const geometry = await runIn(window, `(() => {
    const splitter = document.querySelector(${JSON.stringify(selector)})
    const container = splitter?.closest('[data-split-container]')
    if (!splitter || !container) return null
    const splitterBounds = splitter.getBoundingClientRect()
    const containerBounds = container.getBoundingClientRect()
    return {
      x: Math.round(splitterBounds.left + splitterBounds.width / 2),
      y: Math.round(splitterBounds.top + splitterBounds.height / 2),
      targetY: Math.round(containerBounds.top + containerBounds.height * ${targetPercent / 100}),
    }
  })()`)
  assert.ok(geometry, `${selector} must have draggable geometry`)
  window.webContents.sendInputEvent({
    type: 'mouseMove', x: geometry.x, y: geometry.y, movementX: 0, movementY: 0,
  })
  window.webContents.sendInputEvent({
    type: 'mouseDown', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1,
  })
  window.webContents.sendInputEvent({
    type: 'mouseMove',
    x: geometry.x,
    y: geometry.targetY,
    movementX: 0,
    movementY: geometry.targetY - geometry.y,
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp', x: geometry.x, y: geometry.targetY, button: 'left', clickCount: 1,
  })
  await sleep(40)
  const actualValue = await runIn(
    window,
    `Number(document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-valuenow'))`,
  )
  if (Math.abs(actualValue - targetPercent) > 4) {
    // Hidden Electron windows can discard native pointer input. Exercise the same
    // pointer-capture path with real PointerEvents as a deterministic fallback.
    await runIn(window, `(() => {
      const splitter = document.querySelector(${JSON.stringify(selector)})
      const container = splitter?.closest('[data-split-container]')
      if (!splitter || !container) return false
      const splitterBounds = splitter.getBoundingClientRect()
      const containerBounds = container.getBoundingClientRect()
      let captured = false
      const ownCapture = Object.prototype.hasOwnProperty.call(splitter, 'setPointerCapture')
      const ownHas = Object.prototype.hasOwnProperty.call(splitter, 'hasPointerCapture')
      const ownRelease = Object.prototype.hasOwnProperty.call(splitter, 'releasePointerCapture')
      const originalCapture = splitter.setPointerCapture
      const originalHas = splitter.hasPointerCapture
      const originalRelease = splitter.releasePointerCapture
      splitter.setPointerCapture = () => { captured = true }
      splitter.hasPointerCapture = () => captured
      splitter.releasePointerCapture = () => { captured = false }
      const common = {
        bubbles: true, cancelable: true, pointerId: 72, pointerType: 'mouse',
        isPrimary: true, button: 0, buttons: 1,
      }
      const x = splitterBounds.left + splitterBounds.width / 2
      splitter.dispatchEvent(new PointerEvent('pointerdown', {
        ...common, clientX: x, clientY: splitterBounds.top + splitterBounds.height / 2,
      }))
      splitter.dispatchEvent(new PointerEvent('pointermove', {
        ...common, clientX: x,
        clientY: containerBounds.top + containerBounds.height * ${targetPercent / 100},
      }))
      splitter.dispatchEvent(new PointerEvent('pointerup', {
        ...common, buttons: 0, clientX: x,
        clientY: containerBounds.top + containerBounds.height * ${targetPercent / 100},
      }))
      if (ownCapture) splitter.setPointerCapture = originalCapture
      else delete splitter.setPointerCapture
      if (ownHas) splitter.hasPointerCapture = originalHas
      else delete splitter.hasPointerCapture
      if (ownRelease) splitter.releasePointerCapture = originalRelease
      else delete splitter.releasePointerCapture
      return true
    })()`)
  }
  // Keep the window compositor active for later screenshots after native input.
}

async function dragRangeAcrossCalendarBar(window, anchorDate, targetDate, segmentSelector) {
  window.show()
  window.focus()
  window.webContents.focus()
  await sleep(60)
  const geometry = await runIn(window, `(() => {
    const anchor = document.querySelector(
      '.calendar-cell[data-date=${JSON.stringify(anchorDate)}]',
    )
    const targetCell = document.querySelector(
      '.calendar-cell[data-date=${JSON.stringify(targetDate)}]',
    )
    const segment = document.querySelector(${JSON.stringify(segmentSelector)})
    if (!anchor || !targetCell || !segment) return null
    const anchorBounds = anchor.getBoundingClientRect()
    const targetBounds = targetCell.getBoundingClientRect()
    const segmentBounds = segment.getBoundingClientRect()
    const start = {
      x: Math.round(anchorBounds.left + anchorBounds.width / 2),
      y: Math.round(anchorBounds.top + anchorBounds.height / 2),
    }
    const target = {
      x: Math.round(targetBounds.left + targetBounds.width / 2),
      y: Math.round(segmentBounds.top + segmentBounds.height / 2),
    }
    const startHit = document.elementFromPoint(start.x, start.y)
    const targetHit = document.elementFromPoint(target.x, target.y)
    return {
      start,
      target,
      anchorHitDate: startHit?.closest('.calendar-cell')?.dataset.date ?? null,
      targetHitTaskId: targetHit?.closest('.calendar-task-segment')?.dataset.taskId ?? null,
      targetHitClass: targetHit?.className?.baseVal ?? targetHit?.className ?? null,
    }
  })()`)
  assert.ok(geometry, 'Calendar range hit-test geometry must be available')
  assert.equal(geometry.anchorHitDate, anchorDate, 'Range drag must begin on the requested cell')
  assert.ok(geometry.targetHitTaskId, `Target point must hit a task bar: ${JSON.stringify(geometry)}`)

  window.webContents.sendInputEvent({
    type: 'mouseMove',
    x: geometry.start.x,
    y: geometry.start.y,
    movementX: 0,
    movementY: 0,
  })
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: geometry.start.x,
    y: geometry.start.y,
    button: 'left',
    clickCount: 1,
  })
  for (let step = 1; step <= 4; step += 1) {
    const x = Math.round(geometry.start.x
      + ((geometry.target.x - geometry.start.x) * step) / 4)
    const y = Math.round(geometry.start.y
      + ((geometry.target.y - geometry.start.y) * step) / 4)
    window.webContents.sendInputEvent({
      type: 'mouseMove',
      x,
      y,
      movementX: x - geometry.start.x,
      movementY: y - geometry.start.y,
      button: 'left',
    })
  }
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: geometry.target.x,
    y: geometry.target.y,
    button: 'left',
    clickCount: 1,
  })
  await sleep(90)
  const expectedRange = [anchorDate, targetDate].sort()
  const readRange = () => runIn(window, `({
    start: document.querySelector('.calendar-grid')?.dataset.rangeStart,
    end: document.querySelector('.calendar-grid')?.dataset.rangeEnd,
  })`)
  const nativeRange = await readRange()
  let inputPath = 'native-input'
  let hitTestMoves = []
  if (nativeRange.start !== expectedRange[0] || nativeRange.end !== expectedRange[1]) {
    inputPath = 'element-from-point'
    hitTestMoves = await runIn(window, `(() => {
      const start = ${JSON.stringify(geometry.start)}
      const target = ${JSON.stringify(geometry.target)}
      const startElement = document.elementFromPoint(start.x, start.y)
      if (!startElement) return []
      const common = {
        bubbles: true,
        cancelable: true,
        pointerId: 193,
        pointerType: 'mouse',
        isPrimary: true,
      }
      startElement.dispatchEvent(new PointerEvent('pointerdown', {
        ...common,
        button: 0,
        buttons: 1,
        clientX: start.x,
        clientY: start.y,
      }))
      const moves = []
      for (let step = 1; step <= 4; step += 1) {
        const clientX = Math.round(start.x + ((target.x - start.x) * step) / 4)
        const clientY = Math.round(start.y + ((target.y - start.y) * step) / 4)
        const hit = document.elementFromPoint(clientX, clientY)
        moves.push({
          clientX,
          clientY,
          taskId: hit?.closest('.calendar-task-segment')?.dataset.taskId ?? null,
          date: hit?.closest('.calendar-cell')?.dataset.date ?? null,
        })
        hit?.dispatchEvent(new PointerEvent('pointermove', {
          ...common,
          button: 0,
          buttons: 1,
          clientX,
          clientY,
        }))
      }
      window.dispatchEvent(new PointerEvent('pointerup', {
        ...common,
        button: 0,
        buttons: 0,
        clientX: target.x,
        clientY: target.y,
      }))
      return moves
    })()`)
    await sleep(90)
  }
  return {
    ...geometry,
    inputPath,
    nativeRange,
    finalRange: await readRange(),
    hitTestMoves,
  }
}

async function clickCalendarDateNative(window, date) {
  window.show()
  window.focus()
  window.webContents.focus()
  const geometry = await runIn(window, `(() => {
    const cell = document.querySelector(
      '[data-calendar-drop-target][data-date=${JSON.stringify(date)}]',
    )
    if (!cell) return null
    const bounds = cell.getBoundingClientRect()
    const point = {
      x: Math.round(bounds.left + bounds.width / 2),
      y: Math.round(bounds.top + 8),
    }
    return {
      ...point,
      hitDate: document.elementFromPoint(point.x, point.y)
        ?.closest('[data-date]')?.dataset.date ?? null,
    }
  })()`)
  assert.ok(geometry, `Calendar date ${date} must have native click geometry`)
  assert.equal(geometry.hitDate, date, 'Native date click point must hit the requested cell')
  window.webContents.sendInputEvent({
    type: 'mouseMove', x: geometry.x, y: geometry.y, movementX: 0, movementY: 0,
  })
  window.webContents.sendInputEvent({
    type: 'mouseDown', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1,
  })
  window.webContents.sendInputEvent({
    type: 'mouseUp', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1,
  })
  await sleep(60)
  return geometry
}

async function dragTemplateToCalendarNative(window, templateId, date) {
  window.show()
  window.focus()
  window.webContents.focus()
  await sleep(80)
  const geometry = await runIn(window, `(() => {
    const source = document.querySelector(
      '[data-template-id=${JSON.stringify(templateId)}] [data-qa="template-calendar-drag-source"]',
    )
    const cell = document.querySelector(
      '[data-calendar-drop-target][data-date=${JSON.stringify(date)}]',
    )
    if (!source || !cell) return null
    const sourceBounds = source.getBoundingClientRect()
    const cellBounds = cell.getBoundingClientRect()
    window.__daylineNativeDragTrace = { dragstart: null, dragstartState: null, dragover: null, drop: null, dragend: null }
    document.addEventListener('dragstart', (event) => {
      window.__daylineNativeDragTrace.dragstart = {
        at: performance.now(),
        types: [...(event.dataTransfer?.types ?? [])],
        templateId: event.target?.closest?.('[data-template-id]')?.dataset.templateId ?? null,
      }
      requestAnimationFrame(() => {
        const panel = document.querySelector('[data-qa="template-panel"]')
        const calendar = document.querySelector('.calendar-workspace')
        if (!panel || !calendar) return
        const panelBounds = panel.getBoundingClientRect()
        window.__daylineNativeDragTrace.dragstartState = {
          connected: panel.isConnected,
          dragging: panel.dataset.calendarDragging ?? null,
          pointerEvents: getComputedStyle(panel).pointerEvents,
          opacity: getComputedStyle(panel).opacity,
          inert: panel.inert,
          ariaHidden: panel.getAttribute('aria-hidden'),
          panelRight: panelBounds.right,
          calendarLeft: calendar.getBoundingClientRect().left,
        }
      })
    }, { capture: true, once: true })
    document.addEventListener('dragover', (event) => {
      window.__daylineNativeDragTrace.dragover = {
        at: performance.now(),
        date: event.target?.closest?.('[data-date]')?.dataset.date ?? null,
        taskId: event.target?.closest?.('.calendar-task-segment')?.dataset.taskId ?? null,
      }
    }, { capture: true })
    document.addEventListener('drop', (event) => {
      window.__daylineNativeDragTrace.drop = {
        at: performance.now(),
        types: [...(event.dataTransfer?.types ?? [])],
        date: event.target?.closest?.('[data-date]')?.dataset.date ?? null,
        taskId: event.target?.closest?.('.calendar-task-segment')?.dataset.taskId ?? null,
      }
    }, { capture: true, once: true })
    document.addEventListener('dragend', (event) => {
      window.__daylineNativeDragTrace.dragend = {
        at: performance.now(),
        dropEffect: event.dataTransfer?.dropEffect ?? null,
      }
    }, { capture: true, once: true })
    return {
      source: {
        x: Math.round(sourceBounds.left + sourceBounds.width / 2),
        y: Math.round(sourceBounds.top + sourceBounds.height / 2),
      },
      target: {
        x: Math.round(cellBounds.left + cellBounds.width / 2),
        y: Math.round(cellBounds.bottom - Math.min(14, cellBounds.height / 5)),
      },
      sourceHitTemplate: document.elementFromPoint(
        sourceBounds.left + sourceBounds.width / 2,
        sourceBounds.top + sourceBounds.height / 2,
      )?.closest('[data-template-id]')?.dataset.templateId ?? null,
    }
  })()`)
  assert.ok(geometry, `Native template drag geometry must exist for ${templateId} -> ${date}`)
  assert.equal(geometry.sourceHitTemplate, templateId, 'Native drag must begin on the template copy surface')

  const debuggerClient = window.webContents.debugger
  const attachedHere = !debuggerClient.isAttached()
  if (attachedHere) debuggerClient.attach('1.3')
  try {
    await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: geometry.source.x, y: geometry.source.y, button: 'none', buttons: 0,
    })
    await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: geometry.source.x, y: geometry.source.y,
      button: 'left', buttons: 1, clickCount: 1,
    })
    for (let step = 1; step <= 18; step += 1) {
      const point = {
        x: Math.round(geometry.source.x + ((geometry.target.x - geometry.source.x) * step) / 18),
        y: Math.round(geometry.source.y + ((geometry.target.y - geometry.source.y) * step) / 18),
      }
      await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1,
      })
      await sleep(18)
    }
    await sleep(180)
    const during = await runIn(window, `(() => {
    const panel = document.querySelector('[data-qa="template-panel"]')
    const calendar = document.querySelector('.calendar-workspace')
    const hit = document.elementFromPoint(${geometry.target.x}, ${geometry.target.y})
    if (!panel || !calendar) return null
    const panelBounds = panel.getBoundingClientRect()
    return {
      connected: panel.isConnected,
      dragging: panel.dataset.calendarDragging ?? null,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      opacity: getComputedStyle(panel).opacity,
      inert: panel.inert,
      ariaHidden: panel.getAttribute('aria-hidden'),
      panelRight: panelBounds.right,
      calendarLeft: calendar.getBoundingClientRect().left,
      hitDate: hit?.closest('[data-date]')?.dataset.date ?? null,
      hitTaskId: hit?.closest('.calendar-task-segment')?.dataset.taskId ?? null,
      hitInsidePanel: panel.contains(hit),
      trace: window.__daylineNativeDragTrace,
    }
    })()`)
    await debuggerClient.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: geometry.target.x, y: geometry.target.y,
      button: 'left', buttons: 0, clickCount: 1,
    })
    await sleep(260)
    const after = await runIn(window, `(() => {
    const panel = document.querySelector('[data-qa="template-panel"]')
    const action = document.querySelector('[data-rail-action="templates"]')
    if (!panel || !action) return null
    return {
      connected: panel.isConnected,
      dragging: panel.dataset.calendarDragging ?? null,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      expanded: action.getAttribute('aria-expanded'),
      trace: window.__daylineNativeDragTrace,
    }
    })()`)
    return { inputPath: 'Input.dispatchMouseEvent', geometry, during, after }
  } finally {
    if (attachedHere && debuggerClient.isAttached()) debuggerClient.detach()
  }
}

async function typeAndCommit(window, selector, value) {
  window.show()
  window.focus()
  window.webContents.focus()
  await sleep(80)
  assert.equal(
    await runIn(window, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      input?.focus()
      input?.select()
      return Boolean(input)
    })()`),
    true,
  )
  window.webContents.sendInputEvent({
    type: 'keyDown', keyCode: 'A', modifiers: ['control'],
  })
  window.webContents.sendInputEvent({
    type: 'keyUp', keyCode: 'A', modifiers: ['control'],
  })
  await window.webContents.insertText(value)
  await sleep(40)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await sleep(50)
}

async function typeMultiline(window, selector, lines) {
  assert.ok(Array.isArray(lines) && lines.length >= 2)
  window.show()
  window.focus()
  window.webContents.focus()
  await sleep(60)
  assert.equal(
    await runIn(window, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      input?.focus()
      input?.select()
      return Boolean(input)
    })()`),
    true,
  )
  window.webContents.sendInputEvent({
    type: 'keyDown', keyCode: 'A', modifiers: ['control'],
  })
  window.webContents.sendInputEvent({
    type: 'keyUp', keyCode: 'A', modifiers: ['control'],
  })
  for (let index = 0; index < lines.length; index += 1) {
    await window.webContents.insertText(lines[index])
    await sleep(25)
    await runIn(window, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      const end = input?.value.length ?? 0
      input?.setSelectionRange(end, end)
      return true
    })()`)
    if (index === lines.length - 1) continue
    await window.webContents.insertText('\n')
    await sleep(25)
    await runIn(window, `(() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      const end = input?.value.length ?? 0
      input?.setSelectionRange(end, end)
      return true
    })()`)
    assert.equal(
      await runIn(
        window,
        `document.querySelector(${JSON.stringify(selector)})?.value.endsWith('\\n')`,
      ),
      true,
      'A typed template subtask newline must remain until the next line is entered',
    )
  }
}

async function installFixedRendererClock(window, fallbackDateKey) {
  const target = window.webContents.debugger
  if (!target.isAttached()) target.attach('1.3')
  await target.sendCommand('Page.enable')
  await target.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const NativeDate = globalThis.Date
        const requestedDate = new URLSearchParams(location.search).get('qaDate')
        const dateKey = /^\\d{4}-\\d{2}-\\d{2}$/.test(requestedDate || '')
          ? requestedDate
          : ${JSON.stringify(fallbackDateKey)}
        const [year, month, day] = dateKey.split('-').map(Number)
        const fixedTime = new NativeDate(year, month - 1, day, 12, 0, 0, 0).getTime()
        function FixedDate(...args) {
          if (!new.target) return new NativeDate(fixedTime).toString()
          return args.length === 0 ? new NativeDate(fixedTime) : new NativeDate(...args)
        }
        Object.setPrototypeOf(FixedDate, NativeDate)
        FixedDate.prototype = NativeDate.prototype
        FixedDate.now = NativeDate.now.bind(NativeDate)
        Object.defineProperty(globalThis, 'Date', {
          configurable: true,
          writable: true,
          value: FixedDate,
        })
      })()
    `,
  })
}

function localDateKey(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function addDaysKey(key, amount) {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  date.setDate(date.getDate() + amount)
  return localDateKey(date)
}

function imageHasVisualDetail(image) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const colors = new Set()
  const stride = width * 4
  for (let y = 0; y < height; y += Math.max(8, Math.floor(height / 80))) {
    for (let x = 0; x < width; x += Math.max(8, Math.floor(width / 120))) {
      const offset = y * stride + x * 4
      colors.add(`${bitmap[offset]}:${bitmap[offset + 1]}:${bitmap[offset + 2]}`)
      if (colors.size >= 12) return true
    }
  }
  return false
}

function createQaStore(today) {
  const createdAt = '2026-08-11T01:00:00.000Z'
  const tags = [
    ['builtin-coral', '코랄', '#EF6F61', 'coral'],
    ['builtin-violet', '바이올렛', '#8B6FD6', 'violet'],
    ['builtin-sage', '세이지', '#6F9F7D', 'sage'],
    ['builtin-blue', '블루', '#4F86C6', 'blue'],
    ['builtin-amber', '앰버', '#D99A32', 'amber'],
    ['builtin-rose', '로즈', '#D66787', null],
    ['builtin-teal', '틸', '#3F9B96', null],
    ['builtin-indigo', '인디고', '#5C6AC4', null],
    ['builtin-slate', '슬레이트', '#718096', null],
  ].map(([id, name, color, legacyColor], position) => ({
    id,
    name,
    color,
    builtIn: true,
    legacyColor,
    position,
    createdAt,
    updatedAt: createdAt,
  }))
  const subTask = (id, title, minute) => ({
    id,
    title,
    completed: false,
    completedAt: null,
    createdAt: `2026-08-11T01:0${minute}:00.000Z`,
    updatedAt: `2026-08-11T01:0${minute}:00.000Z`,
  })
  const task = (id, title, color, tagId, position, overrides = {}) => ({
    id,
    title,
    note: '',
    startDate: today,
    dueDate: today,
    dueTime: null,
    color,
    tagId,
    position,
    completed: false,
    completedAt: null,
    deletedAt: null,
    previousCompleted: null,
    createdAt: `2026-08-11T01:1${position}:00.000Z`,
    updatedAt: `2026-08-11T01:1${position}:00.000Z`,
    subTasks: [],
    ...overrides,
  })
  return {
    version: 1,
    revision: 7,
    tasks: [
      task('qa-task-a', 'QA 상세 일정', 'coral', 'builtin-coral', 0, {
        subTasks: [
          subTask('qa-child-a', '기존 세부 일정 A', 1),
          subTask('qa-child-b', '기존 세부 일정 B', 2),
          subTask('qa-child-c', '기존 세부 일정 C', 3),
          subTask('qa-child-d', '기존 세부 일정 D', 4),
          subTask('qa-child-e', '기존 세부 일정 E', 5),
          subTask('qa-child-f', '기존 세부 일정 F', 6),
          subTask('qa-child-g', '기존 세부 일정 G', 7),
          subTask('qa-child-h', '기존 세부 일정 H', 8),
        ],
      }),
      task('qa-task-b', 'QA 태그 일정', 'blue', 'builtin-blue', 1),
      task('qa-task-c', 'QA 시간 일정', 'sage', 'builtin-sage', 2, { dueTime: '14:30' }),
      task('qa-span-same', 'QA same-week span', 'violet', 'builtin-violet', 3, {
        startDate: addDaysKey(today, 1),
        dueDate: addDaysKey(today, 3),
      }),
      task('qa-span-cross', 'QA cross-week span', 'amber', 'builtin-amber', 4, {
        startDate: addDaysKey(today, 3),
        dueDate: addDaysKey(today, 6),
      }),
    ],
    dailyNotes: [
      {
        id: 'qa-note-a',
        content: '첫 번째 퀵 노트',
        noteDate: today,
        completed: false,
        completedAt: null,
        position: 0,
        createdAt: '2026-08-11T01:20:00.000Z',
        updatedAt: '2026-08-11T01:20:00.000Z',
      },
      {
        id: 'qa-note-b',
        content: '두 번째 퀵 노트',
        noteDate: today,
        completed: false,
        completedAt: null,
        position: 1,
        createdAt: '2026-08-11T01:21:00.000Z',
        updatedAt: '2026-08-11T01:21:00.000Z',
      },
      {
        id: 'qa-note-c',
        content: '세 번째 퀵 노트',
        noteDate: today,
        completed: false,
        completedAt: null,
        position: 2,
        createdAt: '2026-08-11T01:22:00.000Z',
        updatedAt: '2026-08-11T01:22:00.000Z',
      },
    ],
    taskTags: tags,
    settings: {
      sidebarSplit: 50,
      widgetSplit: 50,
      fontScale: 1,
      themeColor: '#255F4B',
    },
    taskTemplates: [
      {
        id: 'qa-template-seed',
        title: 'QA 3일 템플릿',
        note: '템플릿 드롭 검증',
        dueTime: '09:15',
        tagId: 'builtin-violet',
        legacyColor: 'violet',
        durationDays: 3,
        subTaskTitles: ['템플릿 세부 A', '템플릿 세부 B'],
        position: 0,
        createdAt: '2026-08-11T01:30:00.000Z',
        updatedAt: '2026-08-11T01:30:00.000Z',
      },
      {
        id: 'qa-template-secondary',
        title: 'QA 보조 템플릿',
        note: '템플릿 순서 검증',
        dueTime: null,
        tagId: 'builtin-sage',
        legacyColor: 'sage',
        durationDays: 1,
        subTaskTitles: [],
        position: 1,
        createdAt: '2026-08-11T01:31:00.000Z',
        updatedAt: '2026-08-11T01:31:00.000Z',
      },
    ],
    migrationWarning: null,
  }
}

let qaTimeout
let qaStage = 'boot'

app.whenReady().then(async () => {
  qaStage = 'app-ready'
  qaTimeout = setTimeout(() => {
    console.error(new Error('Electron feature QA exceeded 120 seconds'))
    app.exit(1)
  }, 120_000)

  const outputDir = path.join(__dirname, '..', 'qa')
  fs.mkdirSync(outputDir, { recursive: true })
  const rendererPath = path.join(__dirname, '..', 'dist', 'index.html')
  const partition = `dayline-capture-qa-${process.pid}-${Date.now()}`
  const today = '2026-08-11'

  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: '#f4f5f0',
    webPreferences: { backgroundThrottling: false, partition },
  })
  const widgetWindow = new BrowserWindow({
    width: 390,
    height: 620,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false, partition },
  })

  const mainLoaded = waitForLoad(mainWindow)
  const widgetLoaded = waitForLoad(widgetWindow)
  await Promise.all([
    mainWindow.loadFile(rendererPath, { query: { mode: 'main', qaDate: today } }),
    widgetWindow.loadFile(rendererPath, { query: { mode: 'widget', qaDate: today } }),
    mainLoaded,
    widgetLoaded,
  ])
  await Promise.all([
    installFixedRendererClock(mainWindow, today),
    installFixedRendererClock(widgetWindow, today),
  ])
  await Promise.all([reloadRenderer(mainWindow), reloadRenderer(widgetWindow)])
  const rangeStart = addDaysKey(today, 5)
  const rangeMiddle = addDaysKey(today, 6)
  const rangeEnd = addDaysKey(today, 7)
  const oneDayTarget = addDaysKey(today, 8)
  const templateDropDate = addDaysKey(today, 9)
  const templateDropMiddle = addDaysKey(today, 10)
  const templateDropEnd = addDaysKey(today, 11)
  await runIn(
    mainWindow,
    `localStorage.setItem('dayline-browser-store-v1', ${JSON.stringify(JSON.stringify(createQaStore(today)))})`,
  )
  await Promise.all([reloadRenderer(mainWindow), reloadRenderer(widgetWindow)])
  qaStage = 'seeded-renderers'
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="quick-note-section"]')
      && document.querySelector('[data-qa="schedule-section"] .task-row[data-task-id]'))`,
    'main calendar and sidebar',
  )
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector('.widget-shell') && document.querySelector('.task-row[data-task-id]'))`,
    'widget task list',
  )

  await sleep(150)
  const [mainImage, widgetImage] = await Promise.all([
    mainWindow.webContents.capturePage(),
    widgetWindow.webContents.capturePage(),
  ])
  fs.writeFileSync(path.join(outputDir, 'main-window.png'), mainImage.toPNG())
  fs.writeFileSync(path.join(outputDir, 'widget-window.png'), widgetImage.toPNG())

  qaStage = 'sidebar-structure'
  const sidebarStructure = await runIn(mainWindow, `
    (() => {
      try {
      const quick = document.querySelector('[data-qa="quick-note-section"]')
      const schedule = document.querySelector('[data-qa="schedule-section"]')
      const splitter = document.querySelector('[data-qa="sidebar-splitter"]')
      const body = document.querySelector('.day-panel-body')
      const noteList = quick?.querySelector('.daily-note-list')
      const taskList = schedule?.querySelector('.day-task-list')
      const quickTitle = quick?.querySelector('#daily-notes-title')
      const quickAdd = quick?.querySelector('[data-qa="quick-note-add"]')
        ?? quick?.querySelector('[aria-label="선택한 날짜에 퀵 노트 추가"]')
      const quickHeading = quick?.querySelector('.panel-section-heading')
      const quickCount = quick?.querySelector('[data-qa="quick-note-count"]')
      const scheduleCount = schedule?.querySelector('[data-qa="schedule-count"]')
      const scheduleAdd = schedule?.querySelector('[data-qa="schedule-add"]')
      if (!quick || !schedule || !splitter || !body || !noteList || !taskList
        || !quickTitle || !quickAdd || !quickHeading || !quickCount || !scheduleCount || !scheduleAdd) return null
      const quickRect = quick.getBoundingClientRect()
      const scheduleRect = schedule.getBoundingClientRect()
      const titleRect = quickTitle.getBoundingClientRect()
      const addRect = quickAdd.getBoundingClientRect()
      const headingRect = quickHeading.getBoundingClientRect()
      const styleText = [...document.styleSheets].flatMap((sheet) => {
        try { return [...sheet.cssRules].map((rule) => rule.cssText) } catch { return [] }
      }).join('\\n')
      return {
        quickHeight: quickRect.height,
        scheduleHeight: scheduleRect.height,
        bodyHeight: body.getBoundingClientRect().height,
        splitValue: Number(splitter.getAttribute('aria-valuenow')),
        splitRole: splitter.getAttribute('role'),
        splitOrientation: splitter.getAttribute('aria-orientation'),
        independentScroll: [noteList, taskList].every((list) =>
          ['auto', 'scroll'].includes(getComputedStyle(list).overflowY)),
        hasCustomScrollbar: styleText.includes('::-webkit-scrollbar')
          || styleText.includes('scrollbar-color'),
        hasLegacyProgress: Boolean(document.querySelector('.day-progress')),
        hasLegacyTip: Boolean(document.querySelector('.panel-tip')),
        hasLegacyCopy: document.body.innerText.includes('오늘의 흐름'),
        quickAddByHeading: quickHeading.contains(quickAdd)
          && addRect.left >= titleRect.right - 1
          && addRect.top >= headingRect.top - 1
          && addRect.bottom <= headingRect.bottom + 1,
        quickCount: {
          value: Number(quickCount.textContent),
          label: quickCount.getAttribute('aria-label'),
          rendered: noteList.querySelectorAll(':scope > [data-daily-note-id]').length,
        },
        scheduleCount: {
          value: Number(scheduleCount.textContent),
          label: scheduleCount.getAttribute('aria-label'),
          rendered: taskList.querySelectorAll(':scope > .task-row[data-task-id]').length,
        },
        scheduleAddInsideHeading: schedule.closest('[data-qa="schedule-section"]')
          ?.querySelector('.panel-section-heading')?.contains(scheduleAdd) === true,
        hasLegacyHeaderAdd: Boolean(document.querySelector(
          '.day-panel-header [aria-label="선택한 날짜에 퀵 노트 추가"]',
        )),
      }
      } catch (error) {
        return { error: String(error?.stack || error) }
      }
    })()
  `)
  assert.equal(sidebarStructure?.error, undefined, sidebarStructure?.error)
  assert.ok(sidebarStructure, 'The two new sidebar sections must render')
  assert.equal(sidebarStructure.hasLegacyProgress, false, 'Legacy today progress must be removed')
  assert.equal(sidebarStructure.hasLegacyTip, false, 'Legacy sidebar tip must be removed')
  assert.equal(sidebarStructure.hasLegacyCopy, false, 'Legacy today flow copy must be removed')
  assert.equal(sidebarStructure.quickAddByHeading, true, 'Quick-note add must sit beside the Quick Note title')
  assert.equal(sidebarStructure.quickCount.value, sidebarStructure.quickCount.rendered)
  assert.equal(sidebarStructure.quickCount.label, `퀵 노트 ${sidebarStructure.quickCount.rendered}개`)
  assert.equal(sidebarStructure.scheduleCount.value, sidebarStructure.scheduleCount.rendered)
  assert.equal(sidebarStructure.scheduleCount.label, `일정 ${sidebarStructure.scheduleCount.rendered}개`)
  assert.equal(sidebarStructure.scheduleAddInsideHeading, true, 'Schedule add must sit in its section header')
  assert.equal(sidebarStructure.hasLegacyHeaderAdd, false, 'Selected-day header must no longer own quick-note add')
  assert.ok(sidebarStructure.bodyHeight > 0, 'Sidebar body must have usable height')
  assert.equal(sidebarStructure.splitRole, 'separator')
  assert.equal(sidebarStructure.splitOrientation, 'horizontal')
  assert.equal(sidebarStructure.splitValue, 50, 'The isolated main split seed must start at 50')
  assert.equal(sidebarStructure.independentScroll, true, 'Main panes must scroll independently')
  assert.equal(sidebarStructure.hasCustomScrollbar, true, 'Pane scrollbars must use the custom style')

  qaStage = 'sidebar-subtask-scroll-and-collapse'
  const expandedSubtaskLayout = await runIn(mainWindow, `(() => {
    const taskList = document.querySelector('[data-qa="schedule-section"] .day-task-list')
    const parent = taskList?.querySelector('.task-row[data-task-id="qa-task-a"]')
    const subtaskList = parent?.querySelector('.sidebar-subtask-list')
    const subtasks = [...(subtaskList?.querySelectorAll('[data-subtask-id]') ?? [])]
    const disclosure = parent?.querySelector('.task-subtask-disclosure')
    const parentBounds = parent?.getBoundingClientRect()
    const lastBounds = subtasks.at(-1)?.getBoundingClientRect()
    const disclosureBounds = disclosure?.getBoundingClientRect()
    if (!taskList || !parent || !subtaskList || !disclosure || !parentBounds || !lastBounds || !disclosureBounds) return null
    return {
      count: subtasks.length,
      disclosureText: disclosure.textContent.trim(),
      expanded: disclosure.getAttribute('aria-expanded'),
      hidden: subtaskList.hidden,
      parentHeight: parentBounds.height,
      parentContainsSubtasks: parent.scrollHeight <= parent.clientHeight + 1
        && lastBounds.bottom <= parentBounds.bottom + 1,
      disclosureVisible: disclosureBounds.left >= parentBounds.left
        && disclosureBounds.right <= parentBounds.right,
      listHasOverflow: taskList.scrollHeight > taskList.clientHeight + 1,
      listScrollHeight: taskList.scrollHeight,
    }
  })()`)
  assert.ok(expandedSubtaskLayout, 'Expanded sidebar subtask layout must be measurable')
  assert.equal(expandedSubtaskLayout.count, 8, 'Every child must participate in the parent layout')
  assert.equal(expandedSubtaskLayout.expanded, 'true', 'Subtasks must be expanded by default')
  assert.equal(expandedSubtaskLayout.hidden, false)
  assert.equal(expandedSubtaskLayout.disclosureText, '간략히')
  assert.equal(expandedSubtaskLayout.disclosureVisible, true, 'Disclosure must remain inside the task card')
  assert.equal(
    expandedSubtaskLayout.parentContainsSubtasks,
    true,
    'Parent height must contain every expanded child instead of clipping them',
  )
  assert.equal(
    expandedSubtaskLayout.listHasOverflow,
    true,
    'Expanded children must contribute to the schedule scrollbar overflow',
  )

  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] [data-task-id="qa-task-a"] .task-subtask-disclosure',
    )?.click()`,
  )
  const collapsedSubtaskLayout = await waitForRenderer(mainWindow, `(() => {
    const taskList = document.querySelector('[data-qa="schedule-section"] .day-task-list')
    const parent = taskList?.querySelector('.task-row[data-task-id="qa-task-a"]')
    const subtaskList = parent?.querySelector('.sidebar-subtask-list')
    const disclosure = parent?.querySelector('.task-subtask-disclosure')
    if (!taskList || !parent || !subtaskList || !disclosure) return null
    if (disclosure.getAttribute('aria-expanded') !== 'false' || !subtaskList.hidden) return null
    return {
      disclosureText: disclosure.textContent.trim(),
      parentHeight: parent.getBoundingClientRect().height,
      listScrollHeight: taskList.scrollHeight,
      modalOpen: Boolean(document.querySelector('.task-modal')),
    }
  })()`, 'collapsed sidebar subtasks')
  assert.equal(collapsedSubtaskLayout.disclosureText, '상세히')
  assert.ok(
    collapsedSubtaskLayout.parentHeight < expandedSubtaskLayout.parentHeight,
    'Collapsing details must reduce the parent card height',
  )
  assert.ok(
    collapsedSubtaskLayout.listScrollHeight < expandedSubtaskLayout.listScrollHeight,
    'Collapsed children must leave the schedule scroll flow',
  )
  assert.equal(collapsedSubtaskLayout.modalOpen, false, 'Disclosure must not open the task modal')

  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] [data-task-id="qa-task-a"] .task-subtask-disclosure',
    )?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] [data-task-id="qa-task-a"] .task-subtask-disclosure',
    )?.getAttribute('aria-expanded') === 'true'
      && !document.querySelector(
        '[data-qa="schedule-section"] [data-task-id="qa-task-a"] .sidebar-subtask-list',
      )?.hidden`,
    're-expanded sidebar subtasks',
  )

  qaStage = 'scaled-schedule-help-card'
  mainWindow.setSize(1050, 680)
  await waitForRenderer(
    mainWindow,
    `window.innerWidth <= 1050 && window.innerHeight <= 680`,
    'minimum main viewport for scaled help',
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="appearance"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="appearance-panel"]'))`,
    'appearance panel for scaled help',
  )
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="font-scale"]', '1.5')`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="font-scale"]')?.value === '1.5'
      && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-20')) === 30`,
    '150 percent interface scale',
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="help"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('#main-help-tour'))`,
    'main help tour at 150 percent scale',
  )
  for (let expectedStep = 2; expectedStep <= 9; expectedStep += 1) {
    await runIn(mainWindow, `document.querySelector('#main-help-tour .help-tour-next')?.click()`)
    await waitForRenderer(
      mainWindow,
      `document.querySelector('#main-help-tour .help-tour-count')?.textContent.trim() === '${expectedStep} / 15'`,
      `main help step ${expectedStep}`,
    )
  }
  mainWindow.showInactive()
  mainWindow.webContents.invalidate()
  await waitForRenderer(
    mainWindow,
    `Number(getComputedStyle(document.querySelector('#main-help-tour')).opacity) > 0.99`,
    'painted schedule help card at 150 percent scale',
  )
  const scaledScheduleHelp = await waitForRenderer(mainWindow, `(() => {
    const card = document.querySelector('#main-help-tour')
    const spotlight = document.querySelector('.help-tour-spotlight')
    const exampleDisclosure = card?.querySelector('.help-example-subtask-head > span')
    if (!card || !spotlight || !exampleDisclosure) return null
    const bounds = card.getBoundingClientRect()
    const style = getComputedStyle(card)
    return {
      count: card.querySelector('.help-tour-count')?.textContent.trim(),
      title: card.querySelector('h2')?.textContent.trim(),
      containsBothLabels: card.textContent.includes('간략히') && card.textContent.includes('상세히'),
      exampleDisclosure: exampleDisclosure.textContent.trim(),
      insideViewport: bounds.top >= 13
        && bounds.left >= 13
        && bounds.right <= innerWidth - 13
        && bounds.bottom <= innerHeight - 13,
      bottomGap: innerHeight - bounds.bottom,
      fontScale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-20')),
      rendered: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
    }
  })()`, 'contained schedule help card at 150 percent scale')
  assert.equal(scaledScheduleHelp.count, '9 / 15')
  assert.equal(scaledScheduleHelp.title, '오른쪽 아래에서 일정과 세부 할 일을 확인해요')
  assert.equal(scaledScheduleHelp.fontScale, 30)
  assert.equal(scaledScheduleHelp.rendered, true)
  assert.equal(scaledScheduleHelp.containsBothLabels, true, 'Help must explain both compact and detailed states')
  assert.equal(scaledScheduleHelp.exampleDisclosure, '간략히')
  assert.equal(
    scaledScheduleHelp.insideViewport,
    true,
    `Scaled schedule help card must stay inside the viewport: ${JSON.stringify(scaledScheduleHelp)}`,
  )
  console.log(`Scaled schedule help: ${JSON.stringify(scaledScheduleHelp)}`)
  await sleep(100)
  const scaledHelpImage = await mainWindow.webContents.capturePage()
  fs.writeFileSync(path.join(outputDir, 'main-window-help-scale-150.png'), scaledHelpImage.toPNG())
  mainWindow.hide()

  await runIn(mainWindow, `document.querySelector('#main-help-tour .help-tour-close')?.click()`)
  await waitForRenderer(mainWindow, `!document.querySelector('#main-help-tour')`, 'closed scaled help tour')
  await runIn(mainWindow, `document.querySelector('[data-rail-action="appearance"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="appearance-panel"]'))`,
    'appearance panel for scale reset',
  )
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="font-scale"]', '1')`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="font-scale"]')?.value === '1'
      && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-20')) === 20`,
    'reset interface scale',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="화면 설정 닫기"]')?.click()`)
  await waitForRenderer(mainWindow, `!document.querySelector('[data-qa="appearance-panel"]')`, 'closed appearance panel')
  mainWindow.setSize(1480, 920)
  await waitForRenderer(
    mainWindow,
    `window.innerWidth >= 1400 && window.innerHeight >= 850`,
    'restored main viewport after scaled help',
  )

  const railStructure = await runIn(mainWindow, `(() => {
    const rail = document.querySelector('.side-rail')
    const shell = document.querySelector('.main-shell')
    const toggle = rail?.querySelector('[data-qa="rail-brand-toggle"]')
    const primary = rail?.querySelector(':scope > nav[aria-label="주요 메뉴"]')
    const bottom = rail?.querySelector(':scope > .rail-bottom')
    if (!rail || !shell || !toggle || !primary || !bottom) return null
    const primaryActions = [...primary.querySelectorAll(':scope > [data-rail-action]')]
    const bottomActions = [...bottom.querySelectorAll(':scope > [data-rail-action]')]
    const describe = (button) => ({
      action: button.dataset.railAction,
      id: button.id,
      controls: button.getAttribute('aria-controls'),
      expanded: button.getAttribute('aria-expanded'),
    })
    const railBounds = rail.getBoundingClientRect()
    const recoveryAction = bottomActions.find((button) => button.dataset.railAction === 'recovery')
    const updateAction = bottomActions.find((button) => button.dataset.railAction === 'updates')
    const recoveryBounds = recoveryAction?.getBoundingClientRect()
    const updateBounds = updateAction?.getBoundingClientRect()
    const helpBounds = bottomActions.find((button) => button.dataset.railAction === 'help')
      ?.getBoundingClientRect()
    const lastPrimaryBounds = primaryActions.at(-1)?.getBoundingClientRect()
    return {
      railState: rail.dataset.state,
      collapsedAttribute: shell.getAttribute('data-rail-collapsed'),
      toggle: {
        controls: toggle.getAttribute('aria-controls'),
        expanded: toggle.getAttribute('aria-expanded'),
        label: toggle.getAttribute('aria-label'),
      },
      primary: primaryActions.map(describe),
      bottom: bottomActions.map(describe),
      allActions: [...rail.querySelectorAll('[data-rail-action]')].map((button) => button.dataset.railAction),
      hasCalendarAction: Boolean(rail.querySelector('[data-rail-action="calendar"]')),
      hasOfflineDot: Boolean(rail.querySelector('.offline-dot')),
      hasLegacyStorageCopy: /(^|\\s)(LOCAL|SQLITE)(\\s|$)/.test(rail.textContent ?? ''),
      recoveryOutsidePrimary: Boolean(recoveryAction) && !primary.contains(recoveryAction),
      recoveryBelowPrimary: Boolean(recoveryBounds && lastPrimaryBounds)
        && recoveryBounds.top >= lastPrimaryBounds.bottom,
      updateAboveRecovery: Boolean(updateBounds && recoveryBounds)
        && updateBounds.bottom <= recoveryBounds.top,
      updateInsideRail: Boolean(updateBounds)
        && updateBounds.left >= railBounds.left
        && updateBounds.right <= railBounds.right
        && updateBounds.bottom <= railBounds.bottom,
      recoveryInsideRail: Boolean(recoveryBounds)
        && recoveryBounds.left >= railBounds.left
        && recoveryBounds.right <= railBounds.right
        && recoveryBounds.bottom <= railBounds.bottom,
      helpBelowRecovery: Boolean(recoveryBounds && helpBounds)
        && helpBounds.top >= recoveryBounds.bottom,
      helpInsideRail: Boolean(helpBounds)
        && helpBounds.left >= railBounds.left
        && helpBounds.right <= railBounds.right
        && helpBounds.bottom <= railBounds.bottom,
    }
  })()`)
  assert.ok(railStructure, 'The redesigned rail must render primary and bottom action groups')
  assert.equal(railStructure.railState, 'open', 'The main rail must start open')
  assert.equal(railStructure.collapsedAttribute, null)
  assert.deepEqual(railStructure.toggle, {
    controls: 'side-rail-navigation',
    expanded: 'true',
    label: '좌측 메뉴 접기',
  })
  assert.deepEqual(
    railStructure.primary,
    [
      { action: 'templates', id: 'rail-action-templates', controls: 'rail-panel-templates', expanded: 'false' },
      { action: 'filters', id: 'rail-action-filters', controls: 'rail-panel-filters', expanded: 'false' },
      { action: 'tags', id: 'rail-action-tags', controls: 'rail-panel-tags', expanded: 'false' },
      { action: 'appearance', id: 'rail-action-appearance', controls: 'rail-panel-appearance', expanded: 'false' },
    ],
    'Primary rail actions must keep the requested accessible order and wiring',
  )
  assert.deepEqual(
    railStructure.bottom,
    [
      { action: 'updates', id: 'rail-action-updates', controls: 'rail-panel-updates', expanded: 'false' },
      { action: 'recovery', id: 'rail-action-recovery', controls: 'recovery-panel', expanded: 'false' },
      { action: 'help', id: 'rail-action-help', controls: 'main-help-tour', expanded: 'false' },
    ],
    'Updates, recent deletion, and help must keep their accessible bottom-rail order',
  )
  assert.deepEqual(
    railStructure.allActions,
    ['templates', 'filters', 'tags', 'appearance', 'updates', 'recovery', 'help'],
  )
  assert.equal(railStructure.hasCalendarAction, false, 'The redundant calendar rail action must be removed')
  assert.equal(railStructure.hasOfflineDot, false, 'The legacy local-status dot must be removed')
  assert.equal(railStructure.hasLegacyStorageCopy, false, 'LOCAL/SQLITE rail copy must be removed')
  assert.equal(railStructure.recoveryOutsidePrimary, true, 'Recovery must sit outside the primary navigation')
  assert.equal(railStructure.recoveryBelowPrimary, true, 'Recovery must remain below the primary action stack')
  assert.equal(railStructure.updateAboveRecovery, true, 'Updates must sit above recent deletion in the bottom rail')
  assert.equal(railStructure.updateInsideRail, true, 'Updates must remain inside the rail bounds')
  assert.equal(railStructure.recoveryInsideRail, true, 'Recovery must remain inside the rail bounds')
  assert.equal(railStructure.helpBelowRecovery, true, 'Help must be the bottom-most rail action')
  assert.equal(railStructure.helpInsideRail, true, 'Help must remain inside the rail bounds')

  qaStage = 'browser-update-unsupported'
  await runIn(mainWindow, `document.querySelector('[data-qa="update-menu-button"]')?.click()`)
  const unsupportedUpdatePanel = await waitForRenderer(mainWindow, `(() => {
    const trigger = document.querySelector('[data-qa="update-menu-button"]')
    const panel = document.querySelector('[data-qa="update-panel"]')
    const status = panel?.querySelector('[data-qa="update-status"]')
    const check = panel?.querySelector('[data-qa="update-check"]')
    if (!trigger || !panel || !status || !check) return null
    return {
      expanded: trigger.getAttribute('aria-expanded'),
      controls: trigger.getAttribute('aria-controls'),
      panelId: panel.id,
      labelledBy: panel.getAttribute('aria-labelledby'),
      unsupportedStatus: status.classList.contains('status-unsupported'),
      politeStatus: status.getAttribute('aria-live'),
      hasUnsupportedNote: Boolean(panel.querySelector('[data-qa="update-unsupported-note"]')),
      checkDisabled: check.disabled,
      hasDownload: Boolean(panel.querySelector('[data-qa="update-download"]')),
      hasInstall: Boolean(panel.querySelector('[data-qa="update-install"]')),
      hasStartupDialog: Boolean(document.querySelector('[data-qa="update-available-dialog"]')),
    }
  })()`, 'unsupported browser update panel')
  assert.deepEqual(unsupportedUpdatePanel, {
    expanded: 'true',
    controls: 'rail-panel-updates',
    panelId: 'rail-panel-updates',
    labelledBy: 'rail-action-updates',
    unsupportedStatus: true,
    politeStatus: 'polite',
    hasUnsupportedNote: true,
    checkDisabled: true,
    hasDownload: false,
    hasInstall: false,
    hasStartupDialog: false,
  }, 'Browser and unsupported builds must explain why updates cannot run without offering unsafe actions')
  await runIn(mainWindow, `document.querySelector('[data-qa="update-panel"] .flyout-header .icon-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="update-panel"]')
      && document.activeElement === document.querySelector('[data-qa="update-menu-button"]')`,
    'unsupported update panel close and focus restoration',
  )

  qaStage = 'rail-collapse-and-reopen'
  await runIn(mainWindow, `document.querySelector('[data-rail-action="filters"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="filter-panel"]'))`,
    'open filter panel before rail collapse',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="rail-brand-toggle"]')?.click()`)
  await sleep(240)
  const collapsedRail = await waitForRenderer(mainWindow, `(() => {
    const shell = document.querySelector('.main-shell')
    const rail = document.querySelector('[data-qa="side-rail"]')
    const toggle = document.querySelector('[data-qa="rail-open-button"]')
    const workspace = document.querySelector('.calendar-workspace')
    const dayPanel = document.querySelector('.day-panel')
    if (!shell || !rail || !toggle || !workspace || !dayPanel) return null
    const rect = (element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    }
    return {
      state: rail.dataset.state,
      collapsed: shell.dataset.railCollapsed,
      expanded: toggle.getAttribute('aria-expanded'),
      label: toggle.getAttribute('aria-label'),
      railHidden: rail.hidden,
      flyoutClosed: !document.querySelector('.rail-flyout'),
      recoveryClosed: !document.querySelector('[data-qa="recovery-panel"]'),
      rail: rect(rail),
      toggle: rect(toggle),
      workspace: rect(workspace),
      dayPanel: rect(dayPanel),
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
        && document.documentElement.scrollHeight <= innerHeight + 1,
    }
  })()`, 'collapsed main rail')
  assert.deepEqual(
    {
      state: collapsedRail.state,
      collapsed: collapsedRail.collapsed,
      expanded: collapsedRail.expanded,
      label: collapsedRail.label,
      railHidden: collapsedRail.railHidden,
      flyoutClosed: collapsedRail.flyoutClosed,
      recoveryClosed: collapsedRail.recoveryClosed,
      noPageOverflow: collapsedRail.noPageOverflow,
    },
    {
      state: 'closed',
      collapsed: 'true',
      expanded: 'false',
      label: '좌측 메뉴 열기',
      railHidden: true,
      flyoutClosed: true,
      recoveryClosed: true,
      noPageOverflow: true,
    },
    `Rail collapse must hide its groups and close overlays: ${JSON.stringify(collapsedRail)}`,
  )
  assert.ok(
    collapsedRail.toggle.left >= collapsedRail.workspace.left - 1
      && collapsedRail.toggle.right <= collapsedRail.workspace.right + 1
      && collapsedRail.workspace.left >= collapsedRail.rail.right - 1
      && collapsedRail.workspace.right <= collapsedRail.dayPanel.left + 1,
    `Collapsed rail columns must remain separated: ${JSON.stringify(collapsedRail)}`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="rail-open-button"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="side-rail"]')?.dataset.state === 'open'
      && !document.querySelector('[data-qa="side-rail"]')?.hidden
      && document.activeElement === document.querySelector('[data-qa="rail-brand-toggle"]')`,
    'reopened main rail',
  )

  qaStage = 'create-outside-click-confirm'
  const taskCountBeforeOutsideCreate = await runIn(
    mainWindow,
    `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.tasks?.length ?? -1`,
  )
  await runIn(mainWindow, `(() => {
    const trigger = document.querySelector('.header-add')
    trigger?.focus()
    trigger?.click()
    return Boolean(trigger)
  })()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"]')?.dataset.mode === 'create'
      && document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'false'`,
    'clean create modal',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="task-modal"]')
      && !document.querySelector('[data-qa="unsaved-task-confirm"]')
      && document.activeElement === document.querySelector('.header-add')`,
    'clean outside click closes without prompt and restores focus',
  )
  assert.equal(
    await runIn(mainWindow, `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.tasks?.length`),
    taskCountBeforeOutsideCreate,
    'Closing an untouched create modal must not add a task',
  )

  await runIn(mainWindow, `(() => {
    const trigger = document.querySelector('.header-add')
    trigger?.focus()
    trigger?.click()
    return Boolean(trigger)
  })()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="task-modal"]'))`, 'invalid dirty create modal')
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="일정 메모"]', '제목 없는 저장 불가 초안')`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'true'`,
    'invalid create draft becomes dirty',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"] [aria-label="일정 메모"]')?.focus()`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  const invalidUnsaved = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-task-confirm"]')
    const modal = document.querySelector('[data-qa="task-modal"]')
    const save = prompt?.querySelector('[data-qa="unsaved-task-save"]')
    const continueButton = prompt?.querySelector('[aria-label="계속 작성"]')
    if (!prompt || !modal || !save || !continueButton) return null
    return {
      role: prompt.getAttribute('role'),
      modal: prompt.getAttribute('aria-modal'),
      text: prompt.querySelector('#unsaved-task-description')?.textContent?.trim(),
      saveDisabled: save.disabled,
      taskModalInert: modal.inert,
      outsideModalInert: [...(document.querySelector('[data-qa="task-modal-backdrop"]')?.parentElement?.children ?? [])]
        .filter((element) => !element.contains(prompt))
        .every((element) => element.inert === true),
      focusOnContinue: document.activeElement === continueButton,
    }
  })()`, 'invalid unsaved prompt')
  assert.deepEqual(invalidUnsaved, {
    role: 'alertdialog',
    modal: 'true',
    text: '변경 사항이 있습니다. 저장하시겠습니까?',
    saveDisabled: true,
    taskModalInert: true,
    outsideModalInert: true,
    focusOnContinue: true,
  })
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.key('[data-qa="unsaved-task-confirm"] [aria-label="계속 작성"]', 'Tab', { shiftKey: true })`),
    true,
  )
  assert.equal(
    await runIn(
      mainWindow,
      `document.activeElement === document.querySelector('[data-qa="unsaved-task-discard"]')`,
    ),
    true,
    'Invalid prompt Shift+Tab must wrap from Continue to Discard while Save is disabled',
  )
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.key('[data-qa="unsaved-task-discard"]', 'Tab')`),
    true,
  )
  assert.equal(
    await runIn(
      mainWindow,
      `document.activeElement === document.querySelector('[data-qa="unsaved-task-confirm"] [aria-label="계속 작성"]')`,
    ),
    true,
    'Invalid prompt Tab must wrap back to Continue',
  )
  await runIn(mainWindow, `window.__daylineQa.key('[data-qa="unsaved-task-confirm"] [aria-label="계속 작성"]', 'Escape')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="unsaved-task-confirm"]')
      && document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'true'
      && document.querySelector('[data-qa="task-modal"] [aria-label="일정 메모"]')?.value === '제목 없는 저장 불가 초안'
      && document.activeElement === document.querySelector('[data-qa="task-modal"] [aria-label="일정 메모"]')`,
    'Escape returns to preserved dirty draft',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="unsaved-task-confirm"]'))`, 'reopened invalid unsaved prompt')
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-task-discard"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="task-modal"]')
      && !document.querySelector('[data-qa="unsaved-task-confirm"]')
      && document.activeElement === document.querySelector('.header-add')`,
    'discard dirty create and restore trigger focus',
  )
  assert.equal(
    await runIn(mainWindow, `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.tasks?.length`),
    taskCountBeforeOutsideCreate,
    'Discarding an invalid dirty draft must not add a task',
  )

  const outsideSaveTitle = 'QA 바깥 저장 일정'
  await runIn(mainWindow, `(() => {
    const trigger = document.querySelector('.header-add')
    trigger?.focus()
    trigger?.click()
    return Boolean(trigger)
  })()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="task-modal"]'))`, 'valid outside-save draft')
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] .title-input', ${JSON.stringify(outsideSaveTitle)})`)
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="시작 날짜"]', '2099-12-30')`)
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="마감 날짜"]', '2099-12-31')`)
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="일정 메모"]', '바깥 클릭 저장 검증')`)
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal"] .time-toggle')?.click()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="task-modal"] [aria-label="마감 시간"]'))`, 'outside-save optional time')
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="마감 시간"]', '16:40')`)
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal"] [data-qa="task-tag-picker"] [data-tag-id="builtin-blue"]')?.click()`)
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="subtask 추가"]', '저장과 함께 추가될 세부 일정')`)
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  const validUnsaved = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-task-confirm"]')
    const save = prompt?.querySelector('[data-qa="unsaved-task-save"]')
    const continueButton = prompt?.querySelector('[aria-label="계속 작성"]')
    if (!prompt || !save || !continueButton || save.disabled) return null
    return {
      focusOnContinue: document.activeElement === continueButton,
      taskModalInert: document.querySelector('[data-qa="task-modal"]')?.inert === true,
    }
  })()`, 'valid unsaved prompt')
  assert.deepEqual(validUnsaved, { focusOnContinue: true, taskModalInert: true })
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.key('[data-qa="unsaved-task-confirm"] [aria-label="계속 작성"]', 'Tab', { shiftKey: true })`),
    true,
  )
  assert.equal(
    await runIn(mainWindow, `document.activeElement === document.querySelector('[data-qa="unsaved-task-save"]')`),
    true,
    'Valid prompt Shift+Tab must wrap to Save',
  )
  await runIn(mainWindow, `(() => {
    const nativeSetItem = Storage.prototype.setItem
    window.__daylineQa.restoreStorageWrites = () => { Storage.prototype.setItem = nativeSetItem }
    window.__daylineQa.storageWriteFailures = 0
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dayline-browser-store-v1') {
        window.__daylineQa.storageWriteFailures += 1
        throw new DOMException('QA storage write failure', 'QuotaExceededError')
      }
      return nativeSetItem.call(this, key, value)
    }
    return true
  })()`)
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-task-save"]')?.click()`)
  const failedOutsideTaskSave = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-task-confirm"]')
    const modal = document.querySelector('[data-qa="task-modal"]')
    const save = prompt?.querySelector('[data-qa="unsaved-task-save"]')
    if (!prompt || !modal || !save || window.__daylineQa.storageWriteFailures !== 1) return null
    return {
      promptOpen: true,
      dirty: modal.dataset.dirty,
      inert: modal.inert,
      title: modal.querySelector('.title-input')?.value,
      pendingSubTask: modal.querySelector('[aria-label="subtask 추가"]')?.value,
      retryEnabled: !save.disabled,
    }
  })()`, 'failed outside task save stays recoverable')
  assert.deepEqual(failedOutsideTaskSave, {
    promptOpen: true,
    dirty: 'true',
    inert: true,
    title: outsideSaveTitle,
    pendingSubTask: '저장과 함께 추가될 세부 일정',
    retryEnabled: true,
  }, 'A failed save must preserve the full dirty draft and allow retry')
  await runIn(mainWindow, `window.__daylineQa.restoreStorageWrites?.()`)
  await runIn(mainWindow, `(() => {
    const save = document.querySelector('[data-qa="unsaved-task-save"]')
    save?.click()
    save?.click()
    return true
  })()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="task-modal"]')
      && !document.querySelector('[data-qa="unsaved-task-confirm"]')`,
    'closed task modal after outside-click save',
  )
  const outsideSavedTask = await runIn(mainWindow, `(() => {
    const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
    const matches = (store?.tasks ?? []).filter((task) => task.title === ${JSON.stringify(outsideSaveTitle)})
    const task = matches[0] ?? {}
    return {
      matchCount: matches.length,
      taskCount: store?.tasks?.length ?? -1,
      startDate: task.startDate,
      dueDate: task.dueDate,
      dueTime: task.dueTime,
      note: task.note,
      tagId: task.tagId,
      subTasks: task.subTasks.map((subTask) => subTask.title),
      promptOpen: Boolean(document.querySelector('[data-qa="unsaved-task-confirm"]')),
      focusRestored: document.activeElement === document.querySelector('.header-add'),
    }
  })()`)
  assert.deepEqual(outsideSavedTask, {
    matchCount: 1,
    taskCount: taskCountBeforeOutsideCreate + 1,
    startDate: '2099-12-30',
    dueDate: '2099-12-31',
    dueTime: '16:40',
    note: '바깥 클릭 저장 검증',
    tagId: 'builtin-blue',
    subTasks: ['저장과 함께 추가될 세부 일정'],
    promptOpen: false,
    focusRestored: true,
  }, 'Outside-click Save must create exactly one complete task even on a repeated click')
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === ${JSON.stringify(today)}
      && document.querySelector('[aria-label="연도 선택"]')?.value === '2026'
      && document.querySelector('[aria-label="월 선택"]')?.value === '7'`,
    'restore fixed month after outside-click save',
  )

  qaStage = 'split-controls'
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.key('[data-qa="sidebar-splitter"]', 'ArrowDown', { shiftKey: true })`,
    ),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="sidebar-splitter"]')?.getAttribute('aria-valuenow') === '60'`,
    'main splitter keyboard adjustment',
  )
  await dragSplitter(mainWindow, '[data-qa="sidebar-splitter"]', 35)
  const pointerSplitValue = await waitForRenderer(
    mainWindow,
    `(() => {
      const value = Number(document.querySelector('[data-qa="sidebar-splitter"]')
        ?.getAttribute('aria-valuenow'))
      return value >= 32 && value <= 38 ? value : 0
    })()`,
    'main splitter pointer adjustment',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `Number(document.querySelector('[data-qa="sidebar-splitter"]')
      ?.getAttribute('aria-valuenow')) === ${pointerSplitValue}`,
    'main split persistence after renderer restart',
  )
  assert.equal(
    await runIn(
      widgetWindow,
      `document.querySelector('[data-qa="widget-splitter"]')?.getAttribute('aria-valuenow')`,
    ),
    '50',
    'Widget split must remain independent from the main split',
  )
  assert.equal(
    await runIn(
      widgetWindow,
      `window.__daylineQa.key('[data-qa="widget-splitter"]', 'End')`,
    ),
    true,
  )
  await waitForRenderer(
    widgetWindow,
    `document.querySelector('[data-qa="widget-splitter"]')?.getAttribute('aria-valuenow') === '80'`,
    'widget split keyboard maximum',
  )
  await reloadRenderer(widgetWindow)
  await waitForRenderer(
    widgetWindow,
    `document.querySelector('[data-qa="widget-splitter"]')?.getAttribute('aria-valuenow') === '80'
      && Boolean(document.querySelector('[data-qa="widget-schedule"]'))
      && Boolean(document.querySelector('[data-qa="widget-quick-notes"]'))`,
    'widget split persistence and panes',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `Number(document.querySelector('[data-qa="sidebar-splitter"]')
        ?.getAttribute('aria-valuenow'))`,
    ),
    pointerSplitValue,
    'Widget split changes must not alter the main split',
  )
  const retiredQuickNoteCopy = ['순간', '메모'].join(' ')
  assert.equal(
    await runIn(
      mainWindow,
      `document.documentElement.innerHTML.includes(${JSON.stringify(retiredQuickNoteCopy)})`,
    ),
    false,
    'Retired quick-note copy must be absent from visible and accessible markup',
  )

  qaStage = 'month-jump'
  // Direct year/month selection must stay in sync with previous/next navigation.
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.setValue('[aria-label="연도 선택"]', '2032')`),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[aria-label="연도 선택"]')?.value === '2032'`,
    'year jump to 2032',
  )
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.setValue('[aria-label="월 선택"]', '1')`),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.header-title h1')?.textContent?.includes('2032년 2월')
      && document.querySelector('[aria-label="월 선택"]')?.value === '1'`,
    'month jump to February 2032',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="이전 달"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[aria-label="월 선택"]')?.value === '0'`,
    'previous month after direct jump',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="다음 달"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[aria-label="월 선택"]')?.value === '1'`,
    'next month after direct jump',
  )
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('.calendar-cell.is-today.is-selected'))`,
    'return to today',
  )

  qaStage = 'korean-holiday-colors'
  // Verify semantic classification and the rendered palette independently.
  // A named holiday always wins over its weekday color.
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[aria-label="연도 선택"]', '2026')`,
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[aria-label="월 선택"]', '5')`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '.calendar-cell[data-date="2026-06-06"][data-day-tone="red"]',
    ))`,
    'June 2026 holiday calendar',
  )
  const juneDayColors = await runIn(mainWindow, `(() => {
    const inspect = (date) => {
      const cell = document.querySelector('.calendar-cell[data-date="' + date + '"]')
      const number = cell?.querySelector('.date-number')
      if (!cell || !number) return null
      return {
        tone: cell.dataset.dayTone,
        holidayName: cell.dataset.holidayName || null,
        holiday: cell.classList.contains('is-holiday'),
        sunday: cell.classList.contains('is-sunday'),
        saturday: cell.classList.contains('is-saturday'),
        color: getComputedStyle(number).color,
        aria: cell.getAttribute('aria-label'),
        title: cell.getAttribute('title'),
      }
    }
    return {
      election: inspect('2026-06-03'),
      saturdayHoliday: inspect('2026-06-06'),
      ordinarySaturday: inspect('2026-06-13'),
      ordinarySunday: inspect('2026-06-14'),
      ordinaryWeekday: inspect('2026-06-15'),
    }
  })()`)
  assert.ok(Object.values(juneDayColors).every(Boolean), 'Every June color probe must render')
  assert.equal(juneDayColors.election.tone, 'red')
  assert.equal(juneDayColors.election.holidayName, '전국동시지방선거')
  assert.equal(juneDayColors.election.holiday, true)
  assert.ok(juneDayColors.election.aria.includes('전국동시지방선거'))
  assert.equal(juneDayColors.saturdayHoliday.tone, 'red')
  assert.equal(juneDayColors.saturdayHoliday.holidayName, '현충일')
  assert.equal(juneDayColors.saturdayHoliday.holiday, true)
  assert.equal(juneDayColors.saturdayHoliday.saturday, true)
  assert.equal(juneDayColors.saturdayHoliday.title, '현충일')
  assert.equal(juneDayColors.ordinarySaturday.tone, 'blue')
  assert.equal(juneDayColors.ordinarySaturday.saturday, true)
  assert.equal(juneDayColors.ordinarySaturday.holiday, false)
  assert.equal(juneDayColors.ordinarySaturday.holidayName, null)
  assert.equal(juneDayColors.ordinarySunday.tone, 'red')
  assert.equal(juneDayColors.ordinarySunday.sunday, true)
  assert.equal(juneDayColors.ordinarySunday.holiday, false)
  assert.equal(juneDayColors.ordinaryWeekday.tone, 'default')
  assert.notEqual(
    juneDayColors.ordinarySaturday.color,
    juneDayColors.ordinarySunday.color,
    'Ordinary Saturday blue and Sunday red must be visually distinct',
  )
  assert.equal(
    juneDayColors.saturdayHoliday.color,
    juneDayColors.ordinarySunday.color,
    'A Saturday holiday must render in red rather than Saturday blue',
  )
  assert.equal(juneDayColors.election.color, juneDayColors.ordinarySunday.color)

  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[aria-label="월 선택"]', '7')`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '.calendar-cell[data-date="2026-08-17"][data-day-tone="red"]',
    ))`,
    'August 2026 substitute holiday calendar',
  )
  const augustDayColors = await runIn(mainWindow, `(() => {
    const inspect = (date) => {
      const cell = document.querySelector('.calendar-cell[data-date="' + date + '"]')
      const number = cell?.querySelector('.date-number')
      if (!cell || !number) return null
      return {
        tone: cell.dataset.dayTone,
        holidayName: cell.dataset.holidayName || null,
        holiday: cell.classList.contains('is-holiday'),
        sunday: cell.classList.contains('is-sunday'),
        saturday: cell.classList.contains('is-saturday'),
        color: getComputedStyle(number).color,
        aria: cell.getAttribute('aria-label'),
        title: cell.getAttribute('title'),
      }
    }
    return {
      saturdayHoliday: inspect('2026-08-15'),
      sunday: inspect('2026-08-16'),
      substitute: inspect('2026-08-17'),
      ordinarySaturday: inspect('2026-08-22'),
    }
  })()`)
  assert.ok(Object.values(augustDayColors).every(Boolean), 'Every August color probe must render')
  assert.deepEqual(
    {
      tone: augustDayColors.saturdayHoliday.tone,
      holiday: augustDayColors.saturdayHoliday.holiday,
      saturday: augustDayColors.saturdayHoliday.saturday,
      name: augustDayColors.saturdayHoliday.holidayName,
    },
    { tone: 'red', holiday: true, saturday: true, name: '광복절' },
  )
  assert.equal(augustDayColors.sunday.tone, 'red')
  assert.equal(augustDayColors.sunday.sunday, true)
  assert.equal(augustDayColors.substitute.tone, 'red')
  assert.equal(augustDayColors.substitute.holiday, true)
  assert.equal(augustDayColors.substitute.holidayName, '대체공휴일(광복절)')
  assert.ok(augustDayColors.substitute.aria.includes('대체공휴일(광복절)'))
  assert.equal(augustDayColors.substitute.title, '대체공휴일(광복절)')
  assert.equal(augustDayColors.ordinarySaturday.tone, 'blue')
  assert.equal(augustDayColors.saturdayHoliday.color, augustDayColors.sunday.color)
  assert.equal(augustDayColors.substitute.color, augustDayColors.sunday.color)
  assert.equal(augustDayColors.ordinarySaturday.color, juneDayColors.ordinarySaturday.color)

  // The widget shares the same semantic attributes and visible colors. The
  // renderer clock is fixed so these weeks stay deterministic in future runs.
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector(
      '.widget-week button[data-date="2026-08-15"][data-day-tone="red"]',
    ))`,
    'fixed August holiday week in widget',
  )
  const augustWidgetDays = await runIn(widgetWindow, `(() => {
    const inspect = (date) => {
      const button = document.querySelector('.widget-week button[data-date="' + date + '"]')
      const label = button?.querySelector('strong')
      if (!button || !label) return null
      return {
        tone: button.dataset.dayTone,
        holidayName: button.dataset.holidayName || null,
        holiday: button.classList.contains('is-holiday'),
        sunday: button.classList.contains('is-sunday'),
        saturday: button.classList.contains('is-saturday'),
        color: getComputedStyle(label).color,
        aria: button.getAttribute('aria-label'),
        title: button.getAttribute('title'),
      }
    }
    return {
      sunday: inspect('2026-08-09'),
      weekday: inspect('2026-08-10'),
      saturdayHoliday: inspect('2026-08-15'),
    }
  })()`)
  assert.ok(Object.values(augustWidgetDays).every(Boolean), 'August widget probes must render')
  assert.equal(augustWidgetDays.sunday.tone, 'red')
  assert.equal(augustWidgetDays.sunday.sunday, true)
  assert.equal(augustWidgetDays.saturdayHoliday.tone, 'red')
  assert.equal(augustWidgetDays.saturdayHoliday.saturday, true)
  assert.equal(augustWidgetDays.saturdayHoliday.holiday, true)
  assert.equal(augustWidgetDays.saturdayHoliday.holidayName, '광복절')
  assert.ok(augustWidgetDays.saturdayHoliday.aria.includes('광복절'))
  assert.equal(augustWidgetDays.saturdayHoliday.title, '광복절')
  assert.equal(augustWidgetDays.saturdayHoliday.color, augustWidgetDays.sunday.color)
  assert.notEqual(augustWidgetDays.weekday.color, augustWidgetDays.sunday.color)

  await loadRendererForQaDate(widgetWindow, rendererPath, 'widget', '2026-06-10')
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector(
      '.widget-week button[data-date="2026-06-13"][data-day-tone="blue"]',
    ))`,
    'fixed ordinary June weekend in widget',
  )
  const juneWidgetDays = await runIn(widgetWindow, `(() => {
    const inspect = (date) => {
      const button = document.querySelector('.widget-week button[data-date="' + date + '"]')
      const label = button?.querySelector('strong')
      if (!button || !label) return null
      return {
        tone: button.dataset.dayTone,
        holiday: button.classList.contains('is-holiday'),
        sunday: button.classList.contains('is-sunday'),
        saturday: button.classList.contains('is-saturday'),
        color: getComputedStyle(label).color,
      }
    }
    return {
      sunday: inspect('2026-06-07'),
      weekday: inspect('2026-06-10'),
      saturday: inspect('2026-06-13'),
    }
  })()`)
  assert.ok(Object.values(juneWidgetDays).every(Boolean), 'June widget probes must render')
  assert.equal(juneWidgetDays.sunday.tone, 'red')
  assert.equal(juneWidgetDays.sunday.sunday, true)
  assert.equal(juneWidgetDays.saturday.tone, 'blue')
  assert.equal(juneWidgetDays.saturday.saturday, true)
  assert.equal(juneWidgetDays.saturday.holiday, false)
  assert.notEqual(
    juneWidgetDays.saturday.color,
    juneWidgetDays.sunday.color,
    'Widget Saturday blue and Sunday red must be visually distinct',
  )
  assert.notEqual(juneWidgetDays.weekday.color, juneWidgetDays.saturday.color)

  await loadRendererForQaDate(widgetWindow, rendererPath, 'widget', today)
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector(
      '.widget-week button[data-date="2026-08-15"][data-day-tone="red"]',
    ))`,
    'restore fixed widget QA date',
  )
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '.calendar-cell[data-date="2026-08-11"].is-today.is-selected',
    ))`,
    'restore fixed main QA date',
  )

  qaStage = 'connected-calendar-segments'
  const sameWeekStart = addDaysKey(today, 1)
  const sharedFriday = addDaysKey(today, 3)
  const crossWeekEnd = addDaysKey(today, 6)
  const nextSunday = addDaysKey(today, 5)
  const segmentLayout = await runIn(mainWindow, `(() => {
    const rect = (element) => {
      if (!element) return null
      const bounds = element.getBoundingClientRect()
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      }
    }
    const read = (segment) => segment ? {
      taskId: segment.dataset.taskId,
      taskStart: segment.dataset.taskStart,
      taskEnd: segment.dataset.taskEnd,
      segmentStart: segment.dataset.segmentStart,
      segmentEnd: segment.dataset.segmentEnd,
      weekRow: Number(segment.dataset.weekRow),
      lane: Number(segment.dataset.lane),
      continuesBefore: segment.dataset.continuesBefore,
      continuesAfter: segment.dataset.continuesAfter,
      rect: rect(segment),
    } : null
    const same = [...document.querySelectorAll(
      '[data-qa="calendar-task-layout"] .calendar-task-segment[data-task-id="qa-span-same"]',
    )].map(read)
    const cross = [...document.querySelectorAll(
      '[data-qa="calendar-task-layout"] .calendar-task-segment[data-task-id="qa-span-cross"]',
    )].map(read).sort((left, right) => left.weekRow - right.weekRow)
    return {
      same,
      cross,
      cells: {
        sameStart: rect(document.querySelector('.calendar-cell[data-date="${sameWeekStart}"]')),
        sameEnd: rect(document.querySelector('.calendar-cell[data-date="${sharedFriday}"]')),
        crossFirstEnd: rect(document.querySelector('.calendar-cell[data-date="${addDaysKey(today, 4)}"]')),
        crossSecondStart: rect(document.querySelector('.calendar-cell[data-date="${nextSunday}"]')),
        crossEnd: rect(document.querySelector('.calendar-cell[data-date="${crossWeekEnd}"]')),
      },
      counts: {
        overlap: document.querySelector('.calendar-cell[data-date="${sharedFriday}"]')?.dataset.taskCount,
        saturday: document.querySelector('.calendar-cell[data-date="${addDaysKey(today, 4)}"]')?.dataset.taskCount,
        monday: document.querySelector('.calendar-cell[data-date="${crossWeekEnd}"]')?.dataset.taskCount,
        hidden: document.querySelector('.calendar-cell[data-date="${sharedFriday}"]')?.dataset.hiddenCount,
      },
      legendText: document.querySelector('.calendar-hint')?.textContent ?? '',
      rangeSummary: Boolean(document.querySelector('[data-qa="range-selection-summary"]')),
    }
  })()`)
  assert.equal(segmentLayout.same.length, 1, 'A same-week range must render as one connected segment')
  assert.equal(segmentLayout.cross.length, 2, 'A Friday-to-Monday range must split once at the week boundary')
  assert.deepEqual(
    {
      taskStart: segmentLayout.same[0].taskStart,
      taskEnd: segmentLayout.same[0].taskEnd,
      segmentStart: segmentLayout.same[0].segmentStart,
      segmentEnd: segmentLayout.same[0].segmentEnd,
      continuesBefore: segmentLayout.same[0].continuesBefore,
      continuesAfter: segmentLayout.same[0].continuesAfter,
    },
    {
      taskStart: sameWeekStart,
      taskEnd: sharedFriday,
      segmentStart: sameWeekStart,
      segmentEnd: sharedFriday,
      continuesBefore: 'false',
      continuesAfter: 'false',
    },
  )
  assert.deepEqual(
    segmentLayout.cross.map((segment) => ({
      segmentStart: segment.segmentStart,
      segmentEnd: segment.segmentEnd,
      weekRow: segment.weekRow,
      continuesBefore: segment.continuesBefore,
      continuesAfter: segment.continuesAfter,
    })),
    [
      {
        segmentStart: sharedFriday,
        segmentEnd: addDaysKey(today, 4),
        weekRow: segmentLayout.same[0].weekRow,
        continuesBefore: 'false',
        continuesAfter: 'true',
      },
      {
        segmentStart: nextSunday,
        segmentEnd: crossWeekEnd,
        weekRow: segmentLayout.same[0].weekRow + 1,
        continuesBefore: 'true',
        continuesAfter: 'false',
      },
    ],
  )
  assert.equal(
    segmentLayout.cross[0].lane,
    segmentLayout.cross[1].lane,
    'A task crossing a week boundary must preserve its visual lane',
  )
  assert.deepEqual(segmentLayout.counts, {
    overlap: '2', saturday: '1', monday: '1', hidden: '0',
  })
  assert.equal(segmentLayout.rangeSummary, true, 'The range summary must remain in the compact legend')
  assert.equal(segmentLayout.legendText.includes('활성'), false, 'The active-state legend must be removed')
  assert.equal(segmentLayout.legendText.includes('비활성'), false, 'The inactive-state legend must be removed')
  assert.ok(
    segmentLayout.same[0].rect.width > segmentLayout.cells.sameStart.width * 2.5,
    'A same-week segment must be visually continuous across all three dates',
  )
  assert.ok(
    Math.abs(segmentLayout.same[0].rect.left - segmentLayout.cells.sameStart.left) <= 10
      && Math.abs(segmentLayout.same[0].rect.right - segmentLayout.cells.sameEnd.right) <= 10,
    'The connected segment must align with its inclusive start and end cells',
  )
  assert.ok(
    Math.abs(segmentLayout.cross[0].rect.right - segmentLayout.cells.crossFirstEnd.right) <= 3
      && Math.abs(segmentLayout.cross[1].rect.left - segmentLayout.cells.crossSecondStart.left) <= 3
      && Math.abs(segmentLayout.cross[1].rect.right - segmentLayout.cells.crossEnd.right) <= 10,
    'Continuation segments must meet the week edges and end on Monday',
  )

  const barRangeHit = await dragRangeAcrossCalendarBar(
    mainWindow,
    rangeEnd,
    sameWeekStart,
    '.calendar-task-segment[data-task-id="qa-span-same"]',
  )
  assert.equal(
    barRangeHit.targetHitTaskId,
    'qa-span-same',
    `The native pointer must be hit-tested against the connected bar: ${JSON.stringify(barRangeHit)}`,
  )
  assert.ok(
    barRangeHit.inputPath === 'native-input'
      || barRangeHit.hitTestMoves.some((move) => move.taskId === 'qa-span-same'),
    `A coordinate pointer move must actually traverse the connected bar: ${JSON.stringify(barRangeHit)}`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === '${sameWeekStart}'
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === '${rangeEnd}'`,
    'native date-range drag across a calendar task bar',
  )
  console.log(`Calendar bar range input path: ${barRangeHit.inputPath}`)
  assert.equal(
    await runIn(mainWindow, `Boolean(document.querySelector('[data-qa="task-modal"]'))`),
    false,
    'Dragging a date range through a task bar must not open task details',
  )
  await clickCalendarDateNative(mainWindow, today)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === ${JSON.stringify(today)}
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === ${JSON.stringify(today)}
      && document.querySelector(
        '[data-calendar-drop-target][data-date="${today}"]',
      )?.classList.contains('is-selected')`,
    'first native date click after bar range drag',
  )

  const syntheticBarRange = await runIn(
    mainWindow,
    `window.__daylineQa.selectRangeAcrossBar(
      ${JSON.stringify(rangeEnd)},
      ${JSON.stringify(sameWeekStart)},
      '.calendar-task-segment[data-task-id="qa-span-same"]',
    )`,
  )
  assert.deepEqual(
    syntheticBarRange,
    { firstDate: rangeEnd, secondDate: sameWeekStart, targetTaskId: 'qa-span-same' },
    'Synthetic pointer range must end on the connected task bar',
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === ${JSON.stringify(sameWeekStart)}
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === ${JSON.stringify(rangeEnd)}`,
    'synthetic date-range drag across a calendar task bar',
  )
  // The pointer-up reset intentionally runs in a zero-delay timer so any
  // compatibility click in the same event turn can be ignored. A later real
  // user click must never be consumed by the stale range guard.
  await sleep(25)
  const firstSyntheticClickDate = addDaysKey(today, 2)
  assert.equal(
    await runIn(
      mainWindow,
      `(() => {
        const cell = document.querySelector(
          '[data-calendar-drop-target][data-date="${firstSyntheticClickDate}"]',
        )
        cell?.click()
        return Boolean(cell)
      })()`,
    ),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === ${JSON.stringify(firstSyntheticClickDate)}
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === ${JSON.stringify(firstSyntheticClickDate)}
      && document.querySelector(
        '[data-calendar-drop-target][data-date="${firstSyntheticClickDate}"]',
      )?.classList.contains('is-selected')`,
    'first synthetic date click after bar range drag',
  )
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === '${today}'
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === '${today}'`,
    'selection reset after hit-tested bar range drag',
  )

  const rangeBeforeCalendarReorder = await runIn(mainWindow, `({
    start: document.querySelector('.calendar-grid')?.dataset.rangeStart,
    end: document.querySelector('.calendar-grid')?.dataset.rangeEnd,
  })`)
  const datesBeforeCalendarReorder = await runIn(mainWindow, `(() => {
    const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
    return Object.fromEntries((store?.tasks ?? [])
      .filter((task) => ['qa-span-same', 'qa-span-cross'].includes(task.id))
      .map((task) => [task.id, [task.startDate, task.dueDate]]))
  })()`)
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragAndDrop(
        '.calendar-task-segment[data-task-id="qa-span-cross"] > .reorder-handle[data-reorder-kind="calendar-task"]',
        '.calendar-task-segment[data-task-id="qa-span-same"]',
      )`,
    ),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `(() => {
      const cross = [...document.querySelectorAll(
        '.calendar-task-segment[data-task-id="qa-span-cross"]',
      )]
      const same = document.querySelector(
        '.calendar-task-segment[data-task-id="qa-span-same"][data-week-row="2"]',
      )
      const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      const byId = Object.fromEntries((store?.tasks ?? []).map((task) => [task.id, task]))
      return cross.length === 2
        && cross.every((segment) => segment.dataset.lane === '0')
        && same?.dataset.lane === '1'
        && byId['qa-span-cross']?.position < byId['qa-span-same']?.position
    })()`,
    'calendar segment drag-handle reorder',
  )
  assert.deepEqual(
    await runIn(mainWindow, `({
      start: document.querySelector('.calendar-grid')?.dataset.rangeStart,
      end: document.querySelector('.calendar-grid')?.dataset.rangeEnd,
    })`),
    rangeBeforeCalendarReorder,
    'Calendar task reorder must not start a date-range selection',
  )
  assert.equal(
    await runIn(mainWindow, `Boolean(document.querySelector('[data-qa="task-modal"]'))`),
    false,
    'Calendar task reorder must not open the task modal',
  )
  assert.deepEqual(
    await runIn(mainWindow, `(() => {
      const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      return Object.fromEntries((store?.tasks ?? [])
        .filter((task) => ['qa-span-same', 'qa-span-cross'].includes(task.id))
        .map((task) => [task.id, [task.startDate, task.dueDate]]))
    })()`),
    datesBeforeCalendarReorder,
    'The calendar reorder handle must change order only, never task dates',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `[...document.querySelectorAll(
      '.calendar-task-segment[data-task-id="qa-span-cross"]',
    )].length === 2
      && [...document.querySelectorAll(
        '.calendar-task-segment[data-task-id="qa-span-cross"]',
      )].every((segment) => segment.dataset.lane === '0')
      && document.querySelector(
        '.calendar-task-segment[data-task-id="qa-span-same"][data-week-row="2"]',
      )?.dataset.lane === '1'`,
    'calendar segment reorder persistence after renderer restart',
  )

  qaStage = 'calendar-task-date-move'
  const preservedTaskFields = (id) => runIn(mainWindow, `(() => {
    const task = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      ?.tasks?.find((candidate) => candidate.id === ${JSON.stringify(id)})
    if (!task) return null
    return {
      title: task.title,
      note: task.note,
      dueTime: task.dueTime,
      color: task.color,
      tagId: task.tagId,
      position: task.position,
      completed: task.completed,
      completedAt: task.completedAt,
      deletedAt: task.deletedAt,
      previousCompleted: task.previousCompleted,
      createdAt: task.createdAt,
      subTasks: task.subTasks.map((subTask) => ({
        id: subTask.id,
        title: subTask.title,
        completed: subTask.completed,
        completedAt: subTask.completedAt,
        createdAt: subTask.createdAt,
        updatedAt: subTask.updatedAt,
      })),
    }
  })()`)
  const singleMoveTarget = '2026-08-24'
  const singleBeforeMove = await preservedTaskFields('qa-task-a')
  const singleMoveGesture = await runIn(
    mainWindow,
    `window.__daylineQa.dragTaskDate('qa-task-a', ${JSON.stringify(today)}, ${JSON.stringify(singleMoveTarget)})`,
  )
  assert.ok(singleMoveGesture, 'Single-day calendar task body must expose a date-move drag surface')
  assert.deepEqual(
    singleMoveGesture.types,
    ['application/x-dayline-task-date'],
    'Task body drag must carry only the date-move MIME, not the order MIME',
  )
  await waitForRenderer(
    mainWindow,
    `(() => {
      const task = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
        ?.tasks?.find((candidate) => candidate.id === 'qa-task-a')
      return task?.startDate === ${JSON.stringify(singleMoveTarget)}
        && task?.dueDate === ${JSON.stringify(singleMoveTarget)}
        && Boolean(document.querySelector(
          '[data-qa="calendar-task-segment"][data-task-id="qa-task-a"][data-task-start="${singleMoveTarget}"][data-task-end="${singleMoveTarget}"]',
        ))
        && !document.querySelector('[data-qa="task-modal"]')
    })()`,
    'single-day calendar task date move',
  )
  assert.deepEqual(
    await preservedTaskFields('qa-task-a'),
    singleBeforeMove,
    'A single-day date move must preserve order, state, metadata, and all subtasks',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '[data-qa="calendar-task-segment"][data-task-id="qa-task-a"][data-task-start="${singleMoveTarget}"]',
    ))`,
    'single-day date move persistence after renderer restart',
  )
  assert.ok(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragTaskDate('qa-task-a', ${JSON.stringify(singleMoveTarget)}, ${JSON.stringify(today)})`,
    ),
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="calendar-task-segment"][data-task-id="qa-task-a"]')
      ?.dataset.taskStart === ${JSON.stringify(today)}`,
    'single-day calendar task restored to its original date',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="calendar-task-segment"][data-task-id="qa-task-a"]')
      ?.dataset.taskStart === ${JSON.stringify(today)}`,
    'restored single-day date persists',
  )

  const multiOriginalStart = sameWeekStart
  const multiOriginalEnd = sharedFriday
  const multiMoveTarget = addDaysKey(today, 4)
  const multiMoveEnd = addDaysKey(multiMoveTarget, 2)
  const multiBeforeMove = await preservedTaskFields('qa-span-same')
  const multiMoveGesture = await runIn(
    mainWindow,
    `window.__daylineQa.dragTaskDate(
      'qa-span-same',
      ${JSON.stringify(multiOriginalStart)},
      ${JSON.stringify(multiMoveTarget)},
      'qa-span-cross',
    )`,
  )
  assert.ok(multiMoveGesture, 'Multi-day task must support dropping on an occupied calendar bar')
  assert.deepEqual(multiMoveGesture.types, ['application/x-dayline-task-date'])
  assert.equal(multiMoveGesture.targetTaskId, 'qa-span-cross')
  await waitForRenderer(
    mainWindow,
    `(() => {
      const task = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
        ?.tasks?.find((candidate) => candidate.id === 'qa-span-same')
      return task?.startDate === ${JSON.stringify(multiMoveTarget)}
        && task?.dueDate === ${JSON.stringify(multiMoveEnd)}
        && Boolean(document.querySelector(
          '[data-qa="calendar-task-segment"][data-task-id="qa-span-same"][data-task-start="${multiMoveTarget}"][data-task-end="${multiMoveEnd}"]',
        ))
        && !document.querySelector('[data-qa="task-modal"]')
    })()`,
    'multi-day task date move over occupied bar',
  )
  assert.deepEqual(
    await preservedTaskFields('qa-span-same'),
    multiBeforeMove,
    'A multi-day date move must preserve duration-independent data and its calendar order',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="calendar-task-segment"][data-task-id="qa-span-same"]')
      ?.dataset.taskStart === ${JSON.stringify(multiMoveTarget)}`,
    'multi-day occupied-bar move persistence',
  )
  assert.ok(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragTaskDate(
        'qa-span-same',
        ${JSON.stringify(multiMoveTarget)},
        ${JSON.stringify(multiOriginalStart)},
      )`,
    ),
  )
  await waitForRenderer(
    mainWindow,
    `(() => {
      const task = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
        ?.tasks?.find((candidate) => candidate.id === 'qa-span-same')
      return task?.startDate === ${JSON.stringify(multiOriginalStart)}
        && task?.dueDate === ${JSON.stringify(multiOriginalEnd)}
    })()`,
    'multi-day task restored without changing duration',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="calendar-task-segment"][data-task-id="qa-span-same"]')
      ?.dataset.taskStart === ${JSON.stringify(multiOriginalStart)}`,
    'restored multi-day date persists',
  )
  assert.deepEqual(await preservedTaskFields('qa-span-same'), multiBeforeMove)

  await runIn(
    mainWindow,
    `document.querySelector(
      '.calendar-task-segment[data-task-id="qa-span-same"] .calendar-task-main',
    )?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"] .title-input')?.value === 'QA same-week span'`,
    'calendar segment left-click detail',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal"] .secondary-button')?.click()`)
  await waitForRenderer(mainWindow, `!document.querySelector('[data-qa="task-modal"]')`, 'calendar detail cancel')
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === '${today}'
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === '${today}'`,
    'calendar selection restoration after segment detail',
  )

  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '.calendar-task-segment[data-task-id="qa-span-cross"] .calendar-task-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '.calendar-task-segment[data-task-id="qa-span-cross"]',
    )?.classList.contains('is-completed')`,
    'calendar segment right-click completion',
  )
  assert.deepEqual(
    await runIn(mainWindow, `({
      start: document.querySelector('.calendar-grid')?.dataset.rangeStart,
      end: document.querySelector('.calendar-grid')?.dataset.rangeEnd,
    })`),
    rangeBeforeCalendarReorder,
    'Calendar segment right-click must not change the selected range',
  )
  await sleep(780)
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '.calendar-task-segment[data-task-id="qa-span-cross"] .calendar-task-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.calendar-task-segment[data-task-id="qa-span-cross"]')
      && !document.querySelector('.delete-confirm-dialog')`,
    'calendar segment second-right-click deletion without confirmation',
  )
  await waitForRenderer(
    mainWindow,
    `window.__daylineQa.clickButtonText('.toast', '실행 취소')`,
    'calendar segment deletion undo',
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '.calendar-task-segment[data-task-id="qa-span-cross"]',
    )?.classList.contains('is-completed')`,
    'restored completed connected calendar segment',
  )

  qaStage = 'quick-note'
  const initialCounts = await runIn(mainWindow, `({
    calendar: Number(document.querySelector('.calendar-cell.is-selected')?.dataset.taskCount ?? 0),
    schedule: document.querySelectorAll(
      '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
    ).length,
    quickNoteBadge: Number(document.querySelector('[data-qa="quick-note-count"]')?.textContent ?? -1),
    scheduleBadge: Number(document.querySelector('[data-qa="schedule-count"]')?.textContent ?? -1),
  })`)

  // The sidebar + adds a multiline daily note, never a calendar task.
  await runIn(mainWindow, `document.querySelector('[aria-label="선택한 날짜에 퀵 노트 추가"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.activeElement?.getAttribute('aria-label') === '새 퀵 노트'`,
    'focused daily-note composer',
  )
  const quickNoteContent = 'QA 퀵 노트 첫 줄\n형식 없는 두 번째 줄'
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.setValue('[aria-label="새 퀵 노트"]', ${JSON.stringify(quickNoteContent)})`,
    ),
    true,
  )
  await runIn(mainWindow, `document.querySelector('.daily-note-composer .note-save')?.click()`)
  const quickNoteId = await waitForRenderer(
    mainWindow,
    `(() => {
      const item = [...document.querySelectorAll('[data-daily-note-id]')]
        .find((candidate) => candidate.querySelector('.note-content')?.textContent
          === ${JSON.stringify(quickNoteContent)})
      return item?.dataset.dailyNoteId ?? ''
    })()`,
    'saved multiline daily note',
  )
  const countsAfterQuickNote = await runIn(mainWindow, `({
    calendar: Number(document.querySelector('.calendar-cell.is-selected')?.dataset.taskCount ?? 0),
    schedule: document.querySelectorAll(
      '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
    ).length,
    quickNoteBadge: Number(document.querySelector('[data-qa="quick-note-count"]')?.textContent ?? -1),
    scheduleBadge: Number(document.querySelector('[data-qa="schedule-count"]')?.textContent ?? -1),
  })`)
  assert.deepEqual(
    countsAfterQuickNote,
    { ...initialCounts, quickNoteBadge: initialCounts.quickNoteBadge + 1 },
    'A quick note increments only its own section count, never a calendar or schedule count',
  )

  qaStage = 'sidebar-schedule-add'
  const scheduleCountBeforeAdd = countsAfterQuickNote.scheduleBadge
  const storeBeforeSidebarScheduleAdd = await runIn(
    mainWindow,
    `localStorage.getItem('dayline-browser-store-v1')`,
  )
  assert.ok(storeBeforeSidebarScheduleAdd, 'Schedule-add QA requires a restorable browser store snapshot')
  await runIn(mainWindow, `document.querySelector('[data-qa="schedule-add"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"]')?.dataset.mode === 'create'
      && document.activeElement === document.querySelector('[data-qa="task-modal"] .title-input')`,
    'schedule section add opens focused task form',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="task-modal"] .title-input', 'QA 사이드바 일정 추가')`,
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('[data-qa="task-modal"] .modal-footer', '일정 추가')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="task-modal"]')
      && Number(document.querySelector('[data-qa="schedule-count"]')?.textContent) === ${scheduleCountBeforeAdd + 1}
      && [...document.querySelectorAll('[data-qa="schedule-section"] .task-title')]
        .some((title) => title.textContent === 'QA 사이드바 일정 추가')`,
    'schedule section add increments its count and renders the task',
  )
  await runIn(
    mainWindow,
    `localStorage.setItem('dayline-browser-store-v1', ${JSON.stringify(storeBeforeSidebarScheduleAdd)})`,
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-daily-note-id="${quickNoteId}"]'))
      && Number(document.querySelector('[data-qa="schedule-count"]')?.textContent) === ${scheduleCountBeforeAdd}
      && ![...document.querySelectorAll('[data-qa="schedule-section"] .task-title')]
        .some((title) => title.textContent === 'QA 사이드바 일정 추가')`,
    'restored schedule state after isolated sidebar add QA',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"] .note-check')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"]')?.classList.contains('is-completed')`,
    'daily-note completion state',
  )

  qaStage = 'reorder-and-persist'
  const noteIdsBeforeDrop = await runIn(
    mainWindow,
    `[...document.querySelectorAll('[data-qa="quick-note-section"] [data-daily-note-id]')]
      .map((row) => row.dataset.dailyNoteId)`,
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragAndDrop(
        '[data-reorder-kind="daily-note"][data-reorder-id="qa-note-a"]',
        '[data-daily-note-id="qa-note-c"]',
      )`,
    ),
    true,
  )
  const expectedNoteDrop = [...noteIdsBeforeDrop]
  expectedNoteDrop.splice(expectedNoteDrop.indexOf('qa-note-a'), 1)
  expectedNoteDrop.splice(noteIdsBeforeDrop.indexOf('qa-note-c'), 0, 'qa-note-a')
  await waitForRenderer(
    mainWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="quick-note-section"] [data-daily-note-id]',
    )].map((row) => row.dataset.dailyNoteId)) === ${JSON.stringify(JSON.stringify(expectedNoteDrop))}`,
    'quick-note pointer reorder',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.key(
        '[data-reorder-kind="daily-note"][data-reorder-id="qa-note-a"]',
        'ArrowUp',
        { altKey: true },
      )`,
    ),
    true,
  )
  const expectedNoteOrder = [...expectedNoteDrop]
  const noteFrom = expectedNoteOrder.indexOf('qa-note-a')
  expectedNoteOrder.splice(noteFrom, 1)
  expectedNoteOrder.splice(noteFrom - 1, 0, 'qa-note-a')
  await waitForRenderer(
    mainWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="quick-note-section"] [data-daily-note-id]',
    )].map((row) => row.dataset.dailyNoteId)) === ${JSON.stringify(JSON.stringify(expectedNoteOrder))}`,
    'quick-note keyboard reorder',
  )

  const taskIdsBeforeDrop = await runIn(mainWindow, `window.__daylineQa.scheduleIds()`)
  assert.deepEqual(taskIdsBeforeDrop, ['qa-task-a', 'qa-task-b', 'qa-task-c'])
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragAndDrop(
        '[data-reorder-kind="task"][data-reorder-id="qa-task-c"]',
        '[data-qa="schedule-section"] [data-task-id="qa-task-a"]',
      )`,
    ),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `JSON.stringify(window.__daylineQa.scheduleIds())
      === JSON.stringify(['qa-task-c', 'qa-task-a', 'qa-task-b'])`,
    'task pointer reorder',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.key(
        '[data-reorder-kind="task"][data-reorder-id="qa-task-c"]',
        'ArrowDown',
        { altKey: true },
      )`,
    ),
    true,
  )
  const expectedTaskOrder = ['qa-task-a', 'qa-task-c', 'qa-task-b']
  await waitForRenderer(
    mainWindow,
    `JSON.stringify(window.__daylineQa.scheduleIds())
      === ${JSON.stringify(JSON.stringify(expectedTaskOrder))}`,
    'task keyboard reorder',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `JSON.stringify(window.__daylineQa.scheduleIds())
      === ${JSON.stringify(JSON.stringify(expectedTaskOrder))}
      && JSON.stringify([...document.querySelectorAll(
        '[data-qa="quick-note-section"] [data-daily-note-id]',
      )].map((row) => row.dataset.dailyNoteId))
        === ${JSON.stringify(JSON.stringify(expectedNoteOrder))}`,
    'task and quick-note order persistence after renderer restart',
  )
  await reloadRenderer(widgetWindow)
  await waitForRenderer(
    widgetWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="widget-schedule"] > .widget-task-list > [data-task-id]',
    )].map((row) => row.dataset.taskId)) === ${JSON.stringify(JSON.stringify(expectedTaskOrder))}`,
    'main task order reflected in widget',
  )

  qaStage = 'detail-cancel'
  const editableTask = await runIn(mainWindow, `
    (() => {
      const rows = [...document.querySelectorAll(
        '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]:not(.is-completed)',
      )]
      const row = rows.find((candidate) => !candidate.querySelector('.task-due-time')) ?? rows[0]
      return row ? {
        id: row.dataset.taskId,
        title: row.querySelector('.task-title')?.textContent ?? '',
      } : null
    })()
  `)
  assert.ok(editableTask?.id && editableTask.title, 'An active task is required for task-detail QA')

  // Draft parent and child edits must be discarded on Cancel.
  await runIn(
    mainWindow,
    `(() => {
      const trigger = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      )
      trigger?.focus()
      trigger?.click()
      return Boolean(trigger)
    })()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-modal'))`, 'task detail modal')
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.task-modal .title-input')?.value === ${JSON.stringify(editableTask.title)}
      && ['.side-rail', '.calendar-workspace', '.day-panel']
        .every((selector) => document.querySelector(selector)?.inert === true)`,
    'hydrated inert task modal',
  )
  const modalAccessibility = await runIn(mainWindow, `
    (() => {
      const modal = document.querySelector('.task-modal')
      const focusable = [...(modal?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
      if (!modal || focusable.length < 2) return null
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
      }))
      const wrappedBackward = document.activeElement === last
      last.focus()
      last.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true,
      }))
      return {
        outsideInert: ['.side-rail', '.calendar-workspace', '.day-panel']
          .every((selector) => document.querySelector(selector)?.inert === true),
        wrappedBackward,
        wrappedForward: document.activeElement === first,
      }
    })()
  `)
  assert.ok(modalAccessibility, 'Task modal must expose a keyboard focus loop')
  assert.equal(modalAccessibility.outsideInert, true, 'Task modal background must be inert')
  assert.equal(modalAccessibility.wrappedBackward, true, 'Shift+Tab must wrap to the modal end')
  assert.equal(modalAccessibility.wrappedForward, true, 'Tab must wrap to the modal start')
  const taskBeforeOutsideEdit = await runIn(mainWindow, `(() => {
    const task = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      ?.tasks?.find((candidate) => candidate.id === '${editableTask.id}')
    return task ? { note: task.note, subTaskCount: task.subTasks.length } : null
  })()`)
  assert.ok(taskBeforeOutsideEdit, 'Task edit backdrop QA requires the persisted opening task')
  assert.equal(
    await runIn(mainWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.dirty`),
    'false',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="task-modal"]')
      && !document.querySelector('[data-qa="unsaved-task-confirm"]')
      && document.activeElement === document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      )`,
    'clean task edit outside close and focus restoration',
  )

  await runIn(mainWindow, `document.querySelector(
    '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
  )?.click()`)
  await waitForRenderer(mainWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'false'`, 'reopened clean task edit')
  await runIn(mainWindow, `window.__daylineQa.setValue(
    '[data-qa="task-modal"] [aria-label="일정 메모"]',
    '바깥 클릭 편집 취소 검증',
  )`)
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal"] [aria-label="일정 메모"]')?.focus()`)
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  const dirtyTaskEditPrompt = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-task-confirm"]')
    const modal = document.querySelector('[data-qa="task-modal"]')
    const continueButton = prompt?.querySelector('[aria-label="계속 작성"]')
    if (!prompt || !modal || !continueButton) return null
    return {
      mode: modal.dataset.mode,
      dirty: modal.dataset.dirty,
      role: prompt.getAttribute('role'),
      text: prompt.querySelector('#unsaved-task-description')?.textContent?.trim(),
      inert: modal.inert,
      ariaHidden: modal.getAttribute('aria-hidden'),
      focusOnContinue: document.activeElement === continueButton,
    }
  })()`, 'dirty task edit confirmation')
  assert.deepEqual(dirtyTaskEditPrompt, {
    mode: 'edit',
    dirty: 'true',
    role: 'alertdialog',
    text: '변경 사항이 있습니다. 저장하시겠습니까?',
    inert: true,
    ariaHidden: 'true',
    focusOnContinue: true,
  })
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-task-confirm"] [aria-label="계속 작성"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="unsaved-task-confirm"]')
      && document.querySelector('[data-qa="task-modal"]')?.inert === false
      && document.querySelector('[data-qa="task-modal"] [aria-label="일정 메모"]')?.value === '바깥 클릭 편집 취소 검증'
      && document.activeElement === document.querySelector('[data-qa="task-modal"] [aria-label="일정 메모"]')`,
    'continue dirty task edit with preserved draft and focus',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="unsaved-task-confirm"]'))`, 'reopened dirty task edit confirmation')
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-task-discard"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="task-modal"]')
      && document.activeElement === document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      )`,
    'discard dirty task edit and restore trigger focus',
  )
  assert.equal(
    await runIn(mainWindow, `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      ?.tasks?.find((task) => task.id === '${editableTask.id}')?.note`),
    taskBeforeOutsideEdit.note,
    'Discarding a dirty task edit must not persist it',
  )

  const outsideEditNote = '바깥 클릭 편집 저장 검증'
  const outsideEditPendingSubTask = '편집 저장과 함께 추가될 세부 일정'
  await runIn(mainWindow, `document.querySelector(
    '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
  )?.click()`)
  await waitForRenderer(mainWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.mode === 'edit'`, 'task edit for outside save')
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="일정 메모"]', ${JSON.stringify(outsideEditNote)})`)
  await runIn(mainWindow, `window.__daylineQa.setValue('[data-qa="task-modal"] [aria-label="subtask 추가"]', ${JSON.stringify(outsideEditPendingSubTask)})`)
  await runIn(mainWindow, `document.querySelector('[data-qa="task-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="unsaved-task-confirm"] [data-qa="unsaved-task-save"]:not([disabled])'))`, 'valid dirty task edit save')
  await runIn(mainWindow, `(() => {
    const save = document.querySelector('[data-qa="unsaved-task-save"]')
    save?.click()
    save?.click()
    return true
  })()`)
  await waitForRenderer(mainWindow, `!document.querySelector('[data-qa="task-modal"]')`, 'outside task edit saved once')
  const outsideEditedTask = await runIn(mainWindow, `(() => {
    const task = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      ?.tasks?.find((candidate) => candidate.id === '${editableTask.id}')
    return task ? {
      note: task.note,
      matchingSubTasks: task.subTasks.filter((subTask) => subTask.title === ${JSON.stringify(outsideEditPendingSubTask)}).length,
      subTaskCount: task.subTasks.length,
      focusRestored: document.activeElement === document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      ),
    } : null
  })()`)
  assert.deepEqual(outsideEditedTask, {
    note: outsideEditNote,
    matchingSubTasks: 1,
    subTaskCount: taskBeforeOutsideEdit.subTaskCount + 1,
    focusRestored: true,
  }, 'A double-clicked edit Save must persist once and include the pending subtask')

  await runIn(mainWindow, `document.querySelector(
    '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
  )?.click()`)
  await waitForRenderer(mainWindow, `document.querySelector('[data-qa="task-modal"]')?.dataset.dirty === 'false'`, 'reopened task after outside edit save')
  const originalDetail = await runIn(mainWindow, `({
    title: document.querySelector('.task-modal .title-input')?.value,
    startDate: document.querySelector('.task-modal [aria-label="시작 날짜"]')?.value,
    dueDate: document.querySelector('.task-modal [aria-label="마감 날짜"]')?.value,
    note: document.querySelector('.task-modal [aria-label="일정 메모"]')?.value,
    tagId: document.querySelector(
      '.task-modal [data-qa="task-tag-picker"] [data-tag-id].is-selected',
    )?.dataset.tagId,
    subTaskCount: document.querySelectorAll('.task-modal .subtask-edit-row').length,
  })`)
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('.task-modal .title-input', ${JSON.stringify(`${editableTask.title} QA 취소`)})`,
  )
  await runIn(mainWindow, `window.__daylineQa.setValue('.task-modal [aria-label="시작 날짜"]', '2099-12-30')`)
  await runIn(mainWindow, `window.__daylineQa.setValue('.task-modal [aria-label="마감 날짜"]', '2099-12-31')`)
  await runIn(mainWindow, `window.__daylineQa.setValue('.task-modal [aria-label="일정 메모"]', '저장되면 안 되는 메모')`)
  await runIn(mainWindow, `
    [...document.querySelectorAll('.task-modal [data-qa="task-tag-picker"] [data-tag-id]')]
      .find((button) => !button.classList.contains('is-selected'))?.click()
    window.__daylineQa.clickButtonText('[aria-label="활성 상태 선택"]', '비활성')
    window.__daylineQa.setValue('[aria-label="subtask 추가"]', '취소될 세부 할 일')
    document.querySelector('.subtask-add-row button')?.click()
  `)
  await waitForRenderer(
    mainWindow,
    `[...document.querySelectorAll('.subtask-edit-row')]
      .some((row) => row.querySelector('input')?.value === '취소될 세부 할 일')`,
    'draft subtask before cancel',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '취소')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.task-modal')
      && document.activeElement === document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
      )
      && ['.side-rail', '.calendar-workspace', '.day-panel']
        .every((selector) => document.querySelector(selector)?.inert === false)`,
    'modal close, background release, and trigger focus restoration',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main')?.click()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-modal'))`, 'reopened task detail')
  const discarded = await runIn(mainWindow, `(() => {
    const modal = document.querySelector('.task-modal')
    return modal?.querySelector('.title-input')?.value === ${JSON.stringify(originalDetail.title)}
      && modal?.querySelector('[aria-label="시작 날짜"]')?.value === ${JSON.stringify(originalDetail.startDate)}
      && modal?.querySelector('[aria-label="마감 날짜"]')?.value === ${JSON.stringify(originalDetail.dueDate)}
      && modal?.querySelector('[aria-label="일정 메모"]')?.value === ${JSON.stringify(originalDetail.note)}
      && modal?.querySelector(
        '[data-qa="task-tag-picker"] [data-tag-id].is-selected',
      )?.dataset.tagId === ${JSON.stringify(originalDetail.tagId)}
      && ![...modal.querySelectorAll('.subtask-edit-row')]
        .some((row) => row.querySelector('input')?.value === '취소될 세부 할 일')
      && modal?.querySelectorAll('.subtask-edit-row').length === ${originalDetail.subTaskCount}
      && [...modal.querySelectorAll('[aria-label="활성 상태 선택"] button')]
        .find((button) => button.textContent?.includes('활성'))?.getAttribute('aria-pressed') === 'true'
  })()`)
  assert.equal(discarded, true, 'Cancel must discard range, parent fields, state, tag, and child drafts')

  qaStage = 'subtask-save'
  // Add two real children and persist them with Change Save.
  for (const title of ['QA 자료 정리', 'QA 검토 요청']) {
    await runIn(
      mainWindow,
      `window.__daylineQa.setValue('[aria-label="subtask 추가"]', ${JSON.stringify(title)})`,
    )
    await runIn(mainWindow, `document.querySelector('.subtask-add-row button')?.click()`)
    await waitForRenderer(
      mainWindow,
      `[...document.querySelectorAll('.subtask-edit-row')]
        .some((row) => row.querySelector('input')?.value === ${JSON.stringify(title)})`,
      `draft child ${title}`,
    )
  }
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  await waitForRenderer(mainWindow, `!document.querySelector('.task-modal')`, 'saved task detail')
  const subTaskState = await waitForRenderer(
    mainWindow,
    `(() => {
      const rows = [...document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      )]
      const ids = rows.map((row) => row.dataset.subtaskId)
      const qaIds = rows
        .filter((row) => ['QA 자료 정리', 'QA 검토 요청'].includes(
          row.querySelector('span')?.textContent?.trim(),
        ))
        .map((row) => row.dataset.subtaskId)
      const qaByTitle = Object.fromEntries(rows
        .map((row) => [row.querySelector('span')?.textContent?.trim(), row.dataset.subtaskId])
        .filter(([title]) => ['QA 자료 정리', 'QA 검토 요청'].includes(title)))
      return ids.length === ${originalDetail.subTaskCount + 2} && qaIds.length === 2
        ? { ids, qaIds, qaByTitle }
        : null
    })()`,
    'two sidebar subtasks after save',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `Number(document.querySelector('.calendar-cell.is-selected')?.dataset.taskCount ?? 0)`,
    ),
    initialCounts.calendar,
    'Subtasks must not add calendar chips',
  )

  // Time is right aligned; missing time and inactive labels are intentionally absent.
  const timeLayout = await runIn(mainWindow, `
    (() => {
      const rows = [...document.querySelectorAll(
        '[data-qa="schedule-section"] .day-task-list > .task-row[data-task-id]',
      )]
      const timed = rows.find((row) => row.querySelector('.task-due-time'))
      const untimed = rows.find((row) => !row.querySelector('.task-due-time'))
      if (!timed || !untimed) return null
      const main = timed.querySelector('.task-row-main').getBoundingClientRect()
      const time = timed.querySelector('.task-due-time').getBoundingClientRect()
      return {
        timedId: timed.dataset.taskId,
        hasPlaceholder: untimed.textContent.includes('시간 없음'),
        hasInactiveLabel: rows.some((row) => row.textContent.includes('비활성')),
        rightAligned: main.right - time.right < 20,
        verticallyCentered: Math.abs((main.top + main.height / 2) - (time.top + time.height / 2)) < 6,
      }
    })()
  `)
  assert.ok(timeLayout, 'Seed data must contain timed and untimed tasks')
  assert.equal(timeLayout.hasPlaceholder, false, 'Untimed rows must have no placeholder')
  assert.equal(timeLayout.hasInactiveLabel, false, 'Rows must not render a redundant inactive label')
  assert.equal(timeLayout.rightAligned, true, 'Due time must be on the row right edge')
  assert.equal(timeLayout.verticallyCentered, true, 'Due time must not render below the title')

  // Individual children toggle without deletion; completing every active child aggregates the parent.
  const activeChildIds = await runIn(mainWindow, `
    [...document.querySelectorAll(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
    )]
      .filter((row) => !row.classList.contains('is-completed'))
      .map((row) => row.dataset.subtaskId)
  `)
  assert.ok(activeChildIds.length >= 2, 'The two newly added subtasks must start active')
  const firstToggleId = subTaskState.qaByTitle['QA 자료 정리']
  assert.ok(firstToggleId, 'The saved QA child must retain its row ID')
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector('[data-subtask-id="${firstToggleId}"]'))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-subtask-id="${firstToggleId}"]')?.classList.contains('is-completed')
      && !document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )?.classList.contains('is-completed')`,
    'first child completion without parent completion',
  )
  for (const childId of activeChildIds.filter((id) => id !== firstToggleId)) {
    await runIn(
      mainWindow,
      `window.__daylineQa.contextMenu(document.querySelector('[data-subtask-id="${childId}"]'))`,
    )
    await waitForRenderer(
      mainWindow,
      `document.querySelector('[data-subtask-id="${childId}"]')?.classList.contains('is-completed')`,
      `child completion ${childId}`,
    )
  }
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
    )?.classList.contains('is-completed')`,
    'parent aggregate completion',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector('[data-subtask-id="${firstToggleId}"]'))`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-subtask-id="${firstToggleId}"]'))
      && !document.querySelector('[data-subtask-id="${firstToggleId}"]')?.classList.contains('is-completed')
      && !document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )?.classList.contains('is-completed')`,
    'child right-click reactivation without deletion',
  )

  // Parent completion preserves its exact list index and cascades to every child.
  const orderBeforeParentCompletion = await runIn(mainWindow, `window.__daylineQa.scheduleIds()`)
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
    )?.classList.contains('is-completed')
      && [...document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      )].every((row) => row.classList.contains('is-completed'))`,
    'parent completion cascade',
  )
  assert.deepEqual(
    await runIn(mainWindow, `window.__daylineQa.scheduleIds()`),
    orderBeforeParentCompletion,
    'Completing a parent must not move it down the list',
  )

  // Regression: editing one child on an all-complete parent must not make the
  // modal's derived parent state cascade over untouched completed siblings.
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('.task-modal'))
      && [...document.querySelectorAll('.task-modal [aria-label="활성 상태 선택"] button')]
        .find((button) => button.textContent?.includes('비활성'))?.getAttribute('aria-pressed') === 'true'
      && [...document.querySelectorAll('.task-modal .subtask-edit-row')]
        .some((row) => row.querySelector('input')?.value === 'QA 자료 정리'
          && row.classList.contains('is-completed'))`,
    'hydrated completed parent detail',
  )
  await runIn(mainWindow, `
    (() => {
      const row = [...document.querySelectorAll('.task-modal .subtask-edit-row')]
        .find((candidate) => candidate.querySelector('input')?.value === 'QA 자료 정리')
      row?.querySelector('.subtask-toggle')?.click()
      return Boolean(row)
    })()
  `)
  await waitForRenderer(
    mainWindow,
    `[...document.querySelectorAll('.task-modal .subtask-edit-row')]
      .some((row) => row.querySelector('input')?.value === 'QA 자료 정리'
        && !row.classList.contains('is-completed'))`,
    'single draft child reactivation',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  try {
    await waitForRenderer(
      mainWindow,
      `!document.querySelector('.task-modal')
        && !document.querySelector('[data-subtask-id="${firstToggleId}"]')?.classList.contains('is-completed')
        && !document.querySelector(
          '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
        )?.classList.contains('is-completed')
        && [...document.querySelectorAll(
          '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
        )].filter((row) => row.dataset.subtaskId !== '${firstToggleId}')
          .every((row) => row.classList.contains('is-completed'))`,
      'isolated child reactivation after detail save',
    )
  } catch (error) {
    const detailState = await runIn(mainWindow, `(() => {
      const parent = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )
      return {
        modalOpen: Boolean(document.querySelector('.task-modal')),
        parentCompleted: parent?.classList.contains('is-completed'),
        children: [...(parent?.querySelectorAll('[data-subtask-id]') ?? [])].map((row) => ({
          id: row.dataset.subtaskId,
          title: row.querySelector('span')?.textContent?.trim(),
          completed: row.classList.contains('is-completed'),
        })),
      }
    })()`)
    throw new Error(`${error.message} State: ${JSON.stringify(detailState)}`)
  }

  // Restore the completed feature state for the color comparison and screenshot.
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
    )?.classList.contains('is-completed')
      && [...document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      )].every((row) => row.classList.contains('is-completed'))`,
    'recompleted parent after isolated child edit',
  )

  // Complete a second color and verify color-specific pale styling in both sidebar and calendar.
  const orderBeforeTimedCompletion = await runIn(mainWindow, `window.__daylineQa.scheduleIds()`)
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )?.classList.contains('is-completed')`,
    'second colored task completion',
  )
  assert.deepEqual(
    await runIn(mainWindow, `window.__daylineQa.scheduleIds()`),
    orderBeforeTimedCompletion,
    'Completing a timed task must not reorder the list',
  )
  const completedColors = await runIn(mainWindow, `
    (() => {
      const first = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"]',
      )
      const second = document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
      )
      const firstChip = document.querySelector(
        '.calendar-task-segment[data-task-id="${editableTask.id}"][data-segment-start="${today}"]',
      )
      const secondChip = document.querySelector(
        '.calendar-task-segment[data-task-id="${timeLayout.timedId}"][data-segment-start="${today}"]',
      )
      if (!first || !second || !firstChip || !secondChip) return null
      return {
        rowBackgrounds: [getComputedStyle(first).backgroundColor, getComputedStyle(second).backgroundColor],
        chipBackgrounds: [getComputedStyle(firstChip).backgroundColor, getComputedStyle(secondChip).backgroundColor],
        taskColors: [
          getComputedStyle(first).getPropertyValue('--task-color').trim(),
          getComputedStyle(second).getPropertyValue('--task-color').trim(),
        ],
        decorations: [
          getComputedStyle(first.querySelector('.task-title')).textDecorationLine,
          getComputedStyle(second.querySelector('.task-title')).textDecorationLine,
        ],
      }
    })()
  `)
  assert.ok(completedColors, 'Two completed colors must remain visible')
  assert.notEqual(...completedColors.taskColors, 'The completed rows must originate from different task colors')
  assert.notEqual(...completedColors.rowBackgrounds, 'Completed sidebar rows must retain distinct pale colors')
  assert.notEqual(...completedColors.chipBackgrounds, 'Completed calendar chips must retain distinct pale colors')
  assert.ok(
    completedColors.decorations.every((value) => value.includes('line-through')),
    'Completed titles must use a line-through',
  )

  qaStage = 'right-click-delete'
  // Existing parent semantics remain active -> inactive -> unconfirmed recent deletion, with undo.
  await sleep(780)
  const rowCountBeforeDelete = orderBeforeTimedCompletion.length
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    ) && !document.querySelector('.delete-confirm-dialog')`,
    'unconfirmed second-right-click deletion',
  )
  assert.equal(
    await runIn(mainWindow, `window.__daylineQa.scheduleIds().length`),
    rowCountBeforeDelete - 1,
  )
  await waitForRenderer(
    mainWindow,
    `window.__daylineQa.clickButtonText('.toast', '실행 취소')`,
    'right-click deletion undo button',
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )?.classList.contains('is-completed')`,
    'restored completed task',
  )

  // Detail status remains a draft until Save, and detail deletion remains guarded.
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-modal'))`, 'restored task detail')
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('[aria-label="활성 상태 선택"]', '활성')`)
  assert.equal(
    await runIn(
      mainWindow,
      `document.querySelector(
        '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
      )?.classList.contains('is-completed')`,
    ),
    true,
    'Detail status must not apply before Save',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.task-modal') && !document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )?.classList.contains('is-completed')`,
    'saved detail reactivation',
  )
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.task-remove-button'))`, 'detail remove button')
  await runIn(mainWindow, `document.querySelector('.task-remove-button')?.click()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.delete-confirm-dialog'))`, 'detail delete warning')
  const alertAccessibility = await runIn(mainWindow, `
    (() => {
      const dialog = document.querySelector('.delete-confirm-dialog')
      const buttons = [...(dialog?.querySelectorAll('button:not([disabled])') ?? [])]
        .filter((button) => button.getClientRects().length > 0)
      if (!dialog || buttons.length < 2) return null
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
      }))
      const wrappedBackward = document.activeElement === last
      last.focus()
      last.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true,
      }))
      return {
        taskModalInert: document.querySelector('.task-modal')?.inert === true,
        wrappedBackward,
        wrappedForward: document.activeElement === first,
      }
    })()
  `)
  assert.ok(alertAccessibility, 'Delete alert must expose a keyboard focus loop')
  assert.equal(alertAccessibility.taskModalInert, true, 'Underlying task modal must be inert during delete alert')
  assert.equal(alertAccessibility.wrappedBackward, true, 'Shift+Tab must wrap inside delete alert')
  assert.equal(alertAccessibility.wrappedForward, true, 'Tab must wrap inside delete alert')
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.delete-confirm-dialog', '취소')`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.delete-confirm-dialog')
      && Boolean(document.querySelector('.task-modal'))
      && document.querySelector('.task-modal')?.inert === false
      && document.activeElement === document.querySelector('.task-remove-button')`,
    'cancelled detail deletion and remove-trigger focus restoration',
  )
  await runIn(mainWindow, `document.querySelector('.task-remove-button')?.click()`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('.delete-confirm-button'))`, 'second detail warning')
  await runIn(mainWindow, `document.querySelector('.delete-confirm-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.task-modal') && !document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    )`,
    'confirmed detail deletion',
  )
  await waitForRenderer(
    mainWindow,
    `window.__daylineQa.clickButtonText('.toast', '실행 취소')`,
    'detail deletion undo button',
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '[data-qa="schedule-section"] .task-row[data-task-id="${timeLayout.timedId}"]',
    ))`,
    'detail-deleted task restoration',
  )

  qaStage = 'date-range-and-template'
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.selectRange(${JSON.stringify(rangeEnd)}, ${JSON.stringify(rangeStart)})`,
    ),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === ${JSON.stringify(rangeStart)}
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === ${JSON.stringify(rangeEnd)}
      && [${[rangeStart, rangeMiddle, rangeEnd].map((date) => JSON.stringify(date)).join(',')}]
        .every((date) => document.querySelector('[data-date="' + date + '"]')
          ?.hasAttribute('data-range-selected'))`,
    'reverse pointer range normalization and inclusive highlight',
  )
  await runIn(mainWindow, `document.querySelector('.header-add')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"] [aria-label="시작 날짜"]')?.value
        === ${JSON.stringify(rangeStart)}
      && document.querySelector('[data-qa="task-modal"] [aria-label="마감 날짜"]')?.value
        === ${JSON.stringify(rangeEnd)}`,
    'range-derived create modal defaults',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="task-modal"] .title-input', 'QA 기간 일정')`,
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '일정 추가')`)
  const rangeTaskId = await waitForRenderer(
    mainWindow,
    `(() => {
      const segment = [...document.querySelectorAll(
        '[data-qa="calendar-task-layout"] .calendar-task-segment[data-task-id]',
      )].find((item) => item.querySelector('.task-chip-title')?.textContent === 'QA 기간 일정')
      return segment?.dataset.taskId || ''
    })()`,
    'saved multi-day task',
  )
  for (const date of [rangeStart, rangeMiddle, rangeEnd]) {
    assert.equal(
      await runIn(
        mainWindow,
        `window.__daylineQa.calendarSegmentsForDate('${date}')
          .some((segment) => segment.dataset.taskId === '${rangeTaskId}')`,
      ),
      true,
      `The range task must appear on ${date}`,
    )
  }
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.calendarSegmentsForDate('${addDaysKey(rangeEnd, 1)}')
        .some((segment) => segment.dataset.taskId === '${rangeTaskId}')`,
    ),
    false,
    'The range task must stop after its inclusive end date',
  )

  await runIn(
    mainWindow,
    `document.querySelector('[data-date="${oneDayTarget}"] .cell-add')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="task-modal"] [aria-label="시작 날짜"]')?.value
        === ${JSON.stringify(oneDayTarget)}
      && document.querySelector('[data-qa="task-modal"] [aria-label="마감 날짜"]')?.value
        === ${JSON.stringify(oneDayTarget)}`,
    'single-day create defaults',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '취소')`)

  await runIn(mainWindow, `document.querySelector('[data-rail-action="templates"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="template-panel"] [data-template-id="qa-template-seed"]'))
      && document.querySelector('[data-rail-action="templates"]')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('[data-qa="template-panel"]')?.getAttribute('aria-labelledby')
        === 'rail-action-templates'
      && document.querySelector('[data-qa="template-form-toggle"]')?.getAttribute('aria-haspopup') === 'dialog'
      && !document.querySelector('[data-qa="template-modal"]')
      && document.activeElement === document.querySelector('[aria-label="반복 일정 닫기"]')`,
    'template panel, seeded card, and hidden create form',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragAndDrop(
        '[data-template-id="qa-template-seed"] [data-qa="template-calendar-drag-source"]',
        '[data-date="${templateDropDate}"][data-template-drop-target]',
      )`,
    ),
    true,
  )
  const droppedTemplateTaskId = await waitForRenderer(
    mainWindow,
    `(() => {
      const segment = [...document.querySelectorAll(
        '[data-qa="calendar-task-layout"] .calendar-task-segment[data-task-id]',
      )].find((item) => item.querySelector('.task-chip-title')?.textContent === 'QA 3일 템플릿')
      return segment?.dataset.taskId || ''
    })()`,
    'template calendar drop without modal',
  )
  assert.equal(
    await runIn(mainWindow, `Boolean(document.querySelector('[data-qa="task-modal"]'))`),
    false,
    'Dropping a template must instantiate immediately without opening the task modal',
  )
  for (const date of [templateDropDate, templateDropMiddle, templateDropEnd]) {
    assert.equal(
      await runIn(
        mainWindow,
        `window.__daylineQa.calendarSegmentsForDate('${date}')
          .some((segment) => segment.dataset.taskId === '${droppedTemplateTaskId}')`,
      ),
      true,
      `The dropped three-day template must include ${date}`,
    )
  }

  // The overlay itself remains a valid calendar drop surface. Its center is
  // Friday, so a three-day template dropped there must run Friday through Sunday.
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragAndDrop(
        '[data-template-id="qa-template-seed"] [data-qa="template-calendar-drag-source"]',
        '.calendar-task-segment[data-task-id="${droppedTemplateTaskId}"]',
      )`,
    ),
    true,
  )
  const barDroppedTemplate = await waitForRenderer(
    mainWindow,
    `(() => {
      const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      const task = (store?.tasks ?? []).find((candidate) => candidate.title === 'QA 3일 템플릿'
        && candidate.id !== '${droppedTemplateTaskId}'
        && !candidate.deletedAt)
      return task ? {
        id: task.id,
        startDate: task.startDate,
        dueDate: task.dueDate,
        modalOpen: Boolean(document.querySelector('[data-qa="task-modal"]')),
      } : null
    })()`,
    'template drop over a connected calendar bar',
  )
  assert.deepEqual(
    barDroppedTemplate,
    {
      id: barDroppedTemplate.id,
      startDate: templateDropMiddle,
      dueDate: addDaysKey(templateDropMiddle, 2),
      modalOpen: false,
    },
    'Dropping on a bar must use the pointer date and instantiate without a modal',
  )

  const templateChildLines = ['템플릿 검증 A', '템플릿 검증 B']
  const templateChildren = templateChildLines.join('\n')
  await runIn(mainWindow, `(() => {
    const trigger = document.querySelector('[data-qa="template-form-toggle"]')
    trigger?.focus()
    trigger?.click()
  })()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'create'
      && document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'false'
      && document.activeElement === document.querySelector(
        '[data-qa="template-form"] [aria-label="템플릿 제목"]',
      )
      && document.querySelector('[data-qa="template-panel"]')?.inert === true`,
    'opened focused template create modal',
  )
  const templateCountBeforeOutsideCreate = await runIn(
    mainWindow,
    `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.taskTemplates?.length ?? -1`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-modal"]')
      && !document.querySelector('[data-qa="unsaved-template-confirm"]')
      && document.activeElement === document.querySelector('[data-qa="template-form-toggle"]')`,
    'clean template create outside close and focus restoration',
  )
  assert.equal(
    await runIn(mainWindow, `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.taskTemplates?.length`),
    templateCountBeforeOutsideCreate,
    'Closing an untouched template create modal must not add a template',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-form-toggle"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'create'
      && document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'false'`,
    'reopened clean template create modal',
  )
  const templateTextareaOrder = await runIn(
    mainWindow,
    `[...document.querySelectorAll('[data-qa="template-form"] textarea')]
      .map((textarea) => textarea.getAttribute('aria-label'))`,
  )
  assert.deepEqual(
    templateTextareaOrder,
    ['템플릿 세부 할 일', '템플릿 메모'],
    'Template form textarea DOM order must place subtasks before memo',
  )
  assert.deepEqual(
    await runIn(mainWindow, `(() => {
      const form = document.querySelector('[data-qa="template-form"]')
      return {
        dateInputs: form?.querySelectorAll('input[type="date"]').length ?? -1,
        hasStartDate: Boolean(form?.querySelector('[aria-label*="시작 날짜"]')),
        hasDueDate: Boolean(form?.querySelector('[aria-label*="마감 날짜"]')),
        hasDuration: Boolean(form?.querySelector('[aria-label="템플릿 기간 일수"]')),
      }
    })()`),
    { dateInputs: 0, hasStartDate: false, hasDueDate: false, hasDuration: true },
    'A reusable template controls duration, not concrete calendar dates',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="template-form"] [aria-label="템플릿 메모"]', '제목 없는 저장 불가 템플릿')`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-form"] [aria-label="템플릿 메모"]')?.focus()`)
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  const invalidTemplatePrompt = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-template-confirm"]')
    const modal = document.querySelector('[data-qa="template-modal"]')
    const save = prompt?.querySelector('[data-qa="unsaved-template-save"]')
    const continueButton = prompt?.querySelector('[aria-label="계속 작성"]')
    if (!prompt || !modal || !save || !continueButton) return null
    return {
      role: prompt.getAttribute('role'),
      modal: prompt.getAttribute('aria-modal'),
      text: prompt.querySelector('#unsaved-template-description')?.textContent?.trim(),
      saveDisabled: save.disabled,
      templateModalInert: modal.inert,
      templateModalAriaHidden: modal.getAttribute('aria-hidden'),
      focusOnContinue: document.activeElement === continueButton,
    }
  })()`, 'invalid dirty template confirmation')
  assert.deepEqual(invalidTemplatePrompt, {
    role: 'alertdialog',
    modal: 'true',
    text: '변경 사항이 있습니다. 저장하시겠습니까?',
    saveDisabled: true,
    templateModalInert: true,
    templateModalAriaHidden: 'true',
    focusOnContinue: true,
  })
  await runIn(mainWindow, `window.__daylineQa.key(
    '[data-qa="unsaved-template-confirm"] [aria-label="계속 작성"]',
    'Escape',
  )`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="unsaved-template-confirm"]')
      && document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'true'
      && document.querySelector('[data-qa="template-modal"]')?.inert === false
      && document.querySelector('[data-qa="template-form"] [aria-label="템플릿 메모"]')?.value === '제목 없는 저장 불가 템플릿'
      && document.activeElement === document.querySelector(
        '[data-qa="template-form"] [aria-label="템플릿 메모"]',
      )`,
    'Escape continues invalid template draft with focus restored',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="unsaved-template-confirm"]'))`, 'reopened invalid template confirmation')
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-template-discard"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-modal"]')
      && !document.querySelector('[data-qa="unsaved-template-confirm"]')
      && document.activeElement === document.querySelector('[data-qa="template-form-toggle"]')`,
    'discard dirty template create and restore trigger focus',
  )
  assert.equal(
    await runIn(mainWindow, `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.taskTemplates?.length`),
    templateCountBeforeOutsideCreate,
    'Discarding a dirty template draft must not add a template',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-form-toggle"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'create'`,
    'template modal before Escape isolation',
  )
  await runIn(
    mainWindow,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-modal"]')
      && Boolean(document.querySelector('[data-qa="template-panel"]'))
      && document.querySelector('[data-rail-action="templates"]')?.getAttribute('aria-expanded') === 'true'
      && document.activeElement === document.querySelector('[data-qa="template-form-toggle"]')`,
    'template Escape closes only the modal and preserves its flyout context',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-form-toggle"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'create'
      && document.activeElement === document.querySelector(
        '[data-qa="template-form"] [aria-label="템플릿 제목"]',
      )`,
    'reopened template create modal',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="template-form"] [aria-label="템플릿 제목"]', 'QA UI 템플릿')`,
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="template-form"] [aria-label="템플릿 메모"]', 'UI CRUD 검증')`,
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="template-form"] [aria-label="템플릿 기간 일수"]', '2')`,
  )
  await typeMultiline(
    mainWindow,
    '[data-qa="template-form"] [aria-label="템플릿 세부 할 일"]',
    templateChildLines,
  )
  const typedTemplateChildren = await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="template-form"] [aria-label="템플릿 세부 할 일"]',
    )?.value`,
  )
  assert.equal(
    typedTemplateChildren,
    templateChildren,
    `Normal per-line typing must preserve both template subtask lines; got ${JSON.stringify(typedTemplateChildren)}`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  const validTemplatePrompt = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-template-confirm"]')
    const modal = document.querySelector('[data-qa="template-modal"]')
    const save = prompt?.querySelector('[data-qa="unsaved-template-save"]')
    const continueButton = prompt?.querySelector('[aria-label="계속 작성"]')
    if (!prompt || !modal || !save || save.disabled || !continueButton) return null
    return {
      dirty: modal.dataset.dirty,
      inert: modal.inert,
      focusOnContinue: document.activeElement === continueButton,
    }
  })()`, 'valid template create confirmation')
  assert.deepEqual(validTemplatePrompt, { dirty: 'true', inert: true, focusOnContinue: true })
  await runIn(mainWindow, `(() => {
    const nativeSetItem = Storage.prototype.setItem
    window.__daylineQa.restoreStorageWrites = () => { Storage.prototype.setItem = nativeSetItem }
    window.__daylineQa.storageWriteFailures = 0
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dayline-browser-store-v1') {
        window.__daylineQa.storageWriteFailures += 1
        throw new DOMException('QA template storage write failure', 'QuotaExceededError')
      }
      return nativeSetItem.call(this, key, value)
    }
    return true
  })()`)
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-template-save"]')?.click()`)
  const failedTemplateSave = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-template-confirm"]')
    const modal = document.querySelector('[data-qa="template-modal"]')
    const save = prompt?.querySelector('[data-qa="unsaved-template-save"]')
    if (!prompt || !modal || !save || window.__daylineQa.storageWriteFailures !== 1) return null
    return {
      promptOpen: true,
      dirty: modal.dataset.dirty,
      inert: modal.inert,
      title: modal.querySelector('[aria-label="템플릿 제목"]')?.value,
      children: modal.querySelector('[aria-label="템플릿 세부 할 일"]')?.value,
      retryEnabled: !save.disabled,
    }
  })()`, 'failed template create save stays recoverable')
  assert.deepEqual(failedTemplateSave, {
    promptOpen: true,
    dirty: 'true',
    inert: true,
    title: 'QA UI 템플릿',
    children: templateChildren,
    retryEnabled: true,
  })
  await runIn(mainWindow, `window.__daylineQa.restoreStorageWrites?.()`)
  await runIn(mainWindow, `(() => {
    const save = document.querySelector('[data-qa="unsaved-template-save"]')
    save?.click()
    save?.click()
    return true
  })()`)
  const uiTemplateId = await waitForRenderer(
    mainWindow,
    `(() => {
      const card = [...document.querySelectorAll('[data-qa="template-panel"] [data-template-id]')]
        .find((item) => item.querySelector('strong')?.textContent === 'QA UI 템플릿')
      return card && !document.querySelector('[data-qa="template-modal"]')
        ? card.dataset.templateId
        : ''
    })()`,
    'template outside-click create and automatic modal close',
  )
  assert.deepEqual(
    await runIn(mainWindow, `(() => {
      const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      const matches = (store?.taskTemplates ?? []).filter((template) => template.title === 'QA UI 템플릿')
      return {
        matches: matches.length,
        total: store?.taskTemplates?.length,
        focusRestored: document.activeElement === document.querySelector('[data-qa="template-form-toggle"]'),
      }
    })()`),
    { matches: 1, total: templateCountBeforeOutsideCreate + 1, focusRestored: true },
    'A repeated template Save click must create exactly one template and restore focus',
  )
  await runIn(
    mainWindow,
    `(() => {
      const trigger = document.querySelector('[aria-label="QA UI 템플릿 수정"]')
      trigger?.focus()
      trigger?.click()
    })()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'edit'
      && document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'false'
      && document.querySelector(
      '[data-qa="template-form"] [aria-label="템플릿 세부 할 일"]',
    )?.value === ${JSON.stringify(templateChildren)}`,
    'template multiline child text persistence',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-modal"]')
      && !document.querySelector('[data-qa="unsaved-template-confirm"]')
      && document.activeElement === document.querySelector('[aria-label="QA UI 템플릿 수정"]')`,
    'clean template edit outside close and focus restoration',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="QA UI 템플릿 수정"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'edit'
      && document.querySelector('[data-qa="template-modal"]')?.dataset.dirty === 'false'`,
    'reopened clean template edit modal',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue(
      '[data-qa="template-form"] [aria-label="템플릿 제목"]',
      '저장하면 안 되는 수정',
    )`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-form"] [aria-label="템플릿 제목"]')?.focus()`)
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  const dirtyTemplateEditPrompt = await waitForRenderer(mainWindow, `(() => {
    const prompt = document.querySelector('[data-qa="unsaved-template-confirm"]')
    const modal = document.querySelector('[data-qa="template-modal"]')
    const continueButton = prompt?.querySelector('[aria-label="계속 작성"]')
    if (!prompt || !modal || !continueButton) return null
    return {
      mode: modal.dataset.mode,
      dirty: modal.dataset.dirty,
      role: prompt.getAttribute('role'),
      text: prompt.querySelector('#unsaved-template-description')?.textContent?.trim(),
      inert: modal.inert,
      ariaHidden: modal.getAttribute('aria-hidden'),
      focusOnContinue: document.activeElement === continueButton,
    }
  })()`, 'dirty template edit confirmation')
  assert.deepEqual(dirtyTemplateEditPrompt, {
    mode: 'edit',
    dirty: 'true',
    role: 'alertdialog',
    text: '변경 사항이 있습니다. 저장하시겠습니까?',
    inert: true,
    ariaHidden: 'true',
    focusOnContinue: true,
  })
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-template-confirm"] [aria-label="계속 작성"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="unsaved-template-confirm"]')
      && document.querySelector('[data-qa="template-modal"]')?.inert === false
      && document.querySelector('[data-qa="template-form"] [aria-label="템플릿 제목"]')?.value === '저장하면 안 되는 수정'
      && document.activeElement === document.querySelector(
        '[data-qa="template-form"] [aria-label="템플릿 제목"]',
      )`,
    'continue dirty template edit with draft and focus preserved',
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(mainWindow, `Boolean(document.querySelector('[data-qa="unsaved-template-confirm"]'))`, 'reopened dirty template edit confirmation')
  await runIn(mainWindow, `document.querySelector('[data-qa="unsaved-template-discard"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-modal"]')
      && document.querySelector('[data-template-id="${uiTemplateId}"] strong')?.textContent === 'QA UI 템플릿'
      && document.activeElement === document.querySelector('[aria-label="QA UI 템플릿 수정"]')`,
    'discarded dirty template edit and restored focus',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="QA UI 템플릿 수정"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="template-modal"]')?.dataset.mode === 'edit'
      && document.querySelector('[data-qa="template-form"] [aria-label="템플릿 제목"]')?.value === 'QA UI 템플릿'`,
    'reopened clean template edit form',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue(
      '[data-qa="template-form"] [aria-label="템플릿 제목"]',
      'QA 수정 템플릿',
    )`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="template-modal-backdrop"]')
    ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="unsaved-template-confirm"] [data-qa="unsaved-template-save"]:not([disabled])'))
      && document.querySelector('[data-qa="template-modal"]')?.inert === true`,
    'valid template edit outside-save confirmation',
  )
  await runIn(mainWindow, `(() => {
    const save = document.querySelector('[data-qa="unsaved-template-save"]')
    save?.click()
    save?.click()
    return true
  })()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-template-id="${uiTemplateId}"] strong')?.textContent
      === 'QA 수정 템플릿'
      && !document.querySelector('[data-qa="template-modal"]')
      && !document.querySelector('[data-qa="unsaved-template-confirm"]')
      && document.activeElement === document.querySelector('[aria-label="QA 수정 템플릿 수정"]')`,
    'template outside-click update and modal close',
  )
  assert.equal(
    await runIn(mainWindow, `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      ?.taskTemplates?.filter((template) => template.id === '${uiTemplateId}'
        && template.title === 'QA 수정 템플릿').length`),
    1,
    'A repeated edit Save click must update exactly one template once',
  )

  qaStage = 'template-reorder-and-gesture-separation'
  await runIn(
    mainWindow,
    `window.__daylineQa.key(
      '[data-calendar-drop-target][data-date="${today}"]',
      'Enter',
    )`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="template-panel"]'))
      && Boolean(document.querySelector('[data-reorder-kind="task"]'))
      && Boolean(document.querySelector('[data-reorder-kind="daily-note"]'))`,
    'today sidebar reorder handles while template panel remains open',
  )
  const templateTaskCountBeforeReorder = await runIn(
    mainWindow,
    `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.tasks?.length ?? -1`,
  )
  const reorderHandleGeometry = await runIn(mainWindow, `(() => {
    const describe = (handle, container) => {
      const handleBounds = handle.getBoundingClientRect()
      const containerBounds = container.getBoundingClientRect()
      return {
        kind: handle.dataset.reorderKind,
        id: handle.dataset.reorderId,
        handle: { left: handleBounds.left, right: handleBounds.right },
        container: { left: containerBounds.left, right: containerBounds.right },
        inRightHalf: (handleBounds.left + handleBounds.right) / 2
          >= (containerBounds.left + containerBounds.right) / 2,
        rightAligned: Math.abs(containerBounds.right - handleBounds.right) <= 22,
        contained: handleBounds.left >= containerBounds.left - 1
          && handleBounds.right <= containerBounds.right + 1,
      }
    }
    return [...document.querySelectorAll('[data-reorder-kind]')].map((handle) => {
      const kind = handle.dataset.reorderKind
      const container = kind === 'template-order'
        ? handle.closest('[data-qa="template-reorder-target"]')
        : kind === 'calendar-task'
          ? handle.closest('[data-qa="calendar-task-segment"]')
          : kind === 'daily-note'
            ? handle.closest('[data-daily-note-id]')
            : handle.closest('[data-task-id]')
      return container ? describe(handle, container) : { kind, missingContainer: true }
    })
  })()`)
  assert.ok(
    reorderHandleGeometry.some((item) => item.kind === 'template-order')
      && reorderHandleGeometry.some((item) => item.kind === 'calendar-task')
      && reorderHandleGeometry.some((item) => item.kind === 'daily-note')
      && reorderHandleGeometry.some((item) => item.kind === 'task'),
    `Every reorder surface must participate in handle geometry QA: ${JSON.stringify(reorderHandleGeometry)}`,
  )
  assert.equal(
    reorderHandleGeometry.every((item) => item.inRightHalf && item.rightAligned && item.contained),
    true,
    `Every mouse reorder handle must be aligned on the item's right: ${JSON.stringify(reorderHandleGeometry)}`,
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.dragAndDrop(
        '[data-reorder-kind="template-order"][data-reorder-id="${uiTemplateId}"]',
        '[data-qa="template-reorder-target"][data-template-id="qa-template-seed"]',
      )`,
    ),
    true,
  )
  const templatePointerOrder = [uiTemplateId, 'qa-template-seed', 'qa-template-secondary']
  await waitForRenderer(
    mainWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="template-list"] > [data-qa="template-reorder-target"]',
    )].map((card) => card.dataset.templateId)) === ${JSON.stringify(JSON.stringify(templatePointerOrder))}`,
    'template pointer reorder',
  )
  assert.deepEqual(
    await runIn(mainWindow, `({
      taskCount: JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.tasks?.length,
      calendarDragging: document.querySelector('[data-qa="template-panel"]')
        ?.hasAttribute('data-calendar-dragging'),
      modalOpen: Boolean(document.querySelector('[data-qa="task-modal"]')),
    })`),
    { taskCount: templateTaskCountBeforeReorder, calendarDragging: false, modalOpen: false },
    'Template order drag must not become a calendar-copy gesture or instantiate a task',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.key(
        '[data-reorder-kind="template-order"][data-reorder-id="${uiTemplateId}"]',
        'ArrowDown',
        { altKey: true },
      )`,
    ),
    true,
  )
  const templateKeyboardOrder = ['qa-template-seed', uiTemplateId, 'qa-template-secondary']
  await waitForRenderer(
    mainWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="template-list"] > [data-qa="template-reorder-target"]',
    )].map((card) => card.dataset.templateId)) === ${JSON.stringify(JSON.stringify(templateKeyboardOrder))}`,
    'template keyboard reorder',
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="quick-note-section"]'))
      && !document.querySelector('[data-qa="template-panel"]')`,
    'main renderer after template reorder',
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="templates"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="template-list"] > [data-qa="template-reorder-target"]',
    )].map((card) => card.dataset.templateId)) === ${JSON.stringify(JSON.stringify(templateKeyboardOrder))}
      && !document.querySelector('[data-qa="template-modal"]')`,
    'template order persistence and hidden form after renderer restart',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-calendar-drop-target][data-date="${oneDayTarget}"]')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.calendar-grid')?.dataset.rangeStart === ${JSON.stringify(oneDayTarget)}
      && document.querySelector('.calendar-grid')?.dataset.rangeEnd === ${JSON.stringify(oneDayTarget)}`,
    'restore selected date after template reorder reload',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.clickButtonText('[data-template-id="${uiTemplateId}"]', '선택 날짜에 추가')`,
  )
  const keyboardTemplateTaskId = await waitForRenderer(
    mainWindow,
    `(() => {
      const segment = window.__daylineQa.calendarSegmentsForDate('${oneDayTarget}')
        .find((item) => item.querySelector('.task-chip-title')?.textContent === 'QA 수정 템플릿')
      return segment?.dataset.taskId || ''
    })()`,
    'template selected-date keyboard fallback',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[aria-label="QA 수정 템플릿 삭제"]')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-template-id="${uiTemplateId}"]')
      && Boolean(document.querySelector(
        '[data-task-id="${keyboardTemplateTaskId}"]',
      ))`,
    'template deletion without deleting instantiated task',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="반복 일정 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="templates"]')`,
    'template close and trigger focus restoration',
  )

  qaStage = 'appearance-tags-filter-widget'
  await runIn(mainWindow, `document.querySelector('[data-rail-action="appearance"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="appearance-panel"] [data-qa="font-scale"]'))
      && document.querySelector('[data-rail-action="appearance"]')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('[data-qa="appearance-panel"]')?.getAttribute('aria-labelledby')
        === 'rail-action-appearance'
      && document.activeElement === document.querySelector('[aria-label="화면 설정 닫기"]')`,
    'focused standalone appearance panel',
  )
  assert.equal(
    await runIn(mainWindow, `Boolean(document.querySelector(
      '[data-qa="appearance-panel"] [data-qa="new-tag-name"]',
    ))`),
    false,
    'Appearance settings must not contain tag management controls',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="appearance-panel"] [data-qa="font-scale"]', '1.2')`,
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="appearance-panel"] [data-qa="theme-color"]', '#315f90')`,
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="tags"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="tag-settings-panel"] [data-qa="new-tag-name"]'))
      && !document.querySelector('[data-qa="appearance-panel"]')
      && document.querySelector('[data-rail-action="appearance"]')?.getAttribute('aria-expanded') === 'false'
      && document.querySelector('[data-rail-action="tags"]')?.getAttribute('aria-expanded') === 'true'
      && document.activeElement === document.querySelector('[aria-label="태그 설정 닫기"]')`,
    'mutually exclusive focused tag settings panel',
  )
  assert.equal(
    await runIn(mainWindow, `Boolean(document.querySelector(
      '[data-qa="tag-settings-panel"] [data-qa="font-scale"], '
        + '[data-qa="tag-settings-panel"] [data-qa="theme-color"]',
    ))`),
    false,
    'Tag settings must not contain appearance controls',
  )
  await typeAndCommit(
    mainWindow,
    '[data-qa="tag-settings-panel"] [data-tag-id="builtin-coral"] input:not([type="color"])',
    '핵심',
  )
  await sleep(80)
  const renameCommitState = await runIn(mainWindow, `(() => {
    const input = document.querySelector(
      '[data-qa="tag-settings-panel"] [data-tag-id="builtin-coral"] input:not([type="color"])',
    )
    const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
    return {
      value: input?.value,
      aria: input?.getAttribute('aria-label'),
      stored: store?.taskTags?.find((tag) => tag.id === 'builtin-coral')?.name,
    }
  })()`)
  if (renameCommitState.stored !== '핵심') {
    throw new Error(`Built-in rename did not commit: ${JSON.stringify(renameCommitState)}`)
  }
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="tag-settings-panel"] [data-tag-id="builtin-coral"] input:not([type="color"])',
    )?.getAttribute('aria-label') === '핵심 이름'`,
    'built-in tag rename commit',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[aria-label="새 태그 색상 #D66787"]')?.click()`,
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="tag-settings-panel"] [data-qa="new-tag-name"]', 'QA 사용자')`,
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.clickButtonText('[data-qa="tag-settings-panel"] .tag-create-row', '추가')`,
  )
  const customTagId = await waitForRenderer(
    mainWindow,
    `(() => {
      const row = [...document.querySelectorAll(
        '[data-qa="tag-settings-panel"] .tag-manager-row[data-tag-id]',
      )].find((item) => item.querySelector('input:not([type="color"])')?.value === 'QA 사용자')
      return row?.dataset.tagId || ''
    })()`,
    'custom tag creation',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `document.querySelector(
        '[data-qa="tag-settings-panel"] [data-tag-id="${customTagId}"] input[type="color"]',
      )?.value.toLowerCase()`,
    ),
    '#d66787',
    'Custom tag must retain the selected palette color',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="태그 설정 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="tag-settings-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="tags"]')
      && document.querySelector('[data-rail-action="tags"]')?.getAttribute('aria-expanded') === 'false'`,
    'tag settings close and trigger focus restoration',
  )
  await Promise.all([reloadRenderer(mainWindow), reloadRenderer(widgetWindow)])
  await waitForRenderer(
    mainWindow,
    `getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim() === '12px'
      && getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim()
        .toLowerCase() === '#315f90'`,
    'font scale and theme persistence in main',
  )
  await waitForRenderer(
    widgetWindow,
    `getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim() === '12px'
      && getComputedStyle(document.documentElement).getPropertyValue('--theme-color').trim()
        .toLowerCase() === '#315f90'
      && document.querySelector('[data-qa="widget-splitter"]')?.getAttribute('aria-valuenow') === '80'`,
    'shared visual settings and independent split persistence in widget',
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="appearance"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="appearance-panel"] [data-qa="font-scale"]')?.value === '1.2'
      && document.querySelector('[data-qa="appearance-panel"] [data-qa="theme-color"]')
        ?.value.toLowerCase() === '#315f90'
      && !document.querySelector('[data-qa="appearance-panel"] [data-tag-id]')`,
    'appearance setting control persistence and separation',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="화면 설정 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="appearance-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="appearance"]')`,
    'appearance close and trigger focus restoration',
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="tags"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="tag-settings-panel"] [data-tag-id="builtin-coral"] input:not([type="color"])',
    )?.value === '핵심'
      && Boolean(document.querySelector(
        '[data-qa="tag-settings-panel"] [data-tag-id="${customTagId}"]',
      ))`,
    'built-in rename and custom tag persistence',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="태그 설정 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="tag-settings-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="tags"]')`,
    'persisted tag panel close focus restoration',
  )
  await runIn(mainWindow, `document.querySelector('.today-button')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-date="${today}"].is-selected'))`,
    'return to today before tag filter',
  )
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] [data-task-id="qa-task-b"] .task-row-main',
    )?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector(
      '[data-qa="task-modal"] [data-qa="task-tag-picker"] [data-tag-id="${customTagId}"]',
    ))`,
    'custom tag in task detail',
  )
  await runIn(
    mainWindow,
    `document.querySelector(
      '[data-qa="task-modal"] [data-qa="task-tag-picker"] [data-tag-id="${customTagId}"]',
    )?.click()`,
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('.modal-footer', '변경 저장')`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] [data-task-id="qa-task-b"] .task-tag-label',
    )?.textContent === 'QA 사용자'`,
    'custom tag assignment',
  )

  const noteCountBeforeFilter = await runIn(
    mainWindow,
    `document.querySelectorAll('[data-qa="quick-note-section"] [data-daily-note-id]').length`,
  )
  await runIn(mainWindow, `document.querySelector('[data-rail-action="filters"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="filter-panel"]'))
      && document.querySelector('[data-rail-action="filters"]')?.getAttribute('aria-expanded') === 'true'
      && document.querySelector('[data-qa="filter-panel"]')?.getAttribute('aria-labelledby')
        === 'rail-action-filters'
      && document.activeElement === document.querySelector('[aria-label="태그 필터 닫기"]')`,
    'tag filter panel',
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-qa="filter-panel"] [data-tag-id="builtin-coral"]')?.click()`,
  )
  await runIn(
    mainWindow,
    `document.querySelector('[data-qa="filter-panel"] [data-tag-id="${customTagId}"]')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `JSON.stringify(window.__daylineQa.scheduleIds())
      === JSON.stringify(['qa-task-a', 'qa-task-b'])`,
    'multi-select OR tag filter',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `document.querySelectorAll('[data-qa="quick-note-section"] [data-daily-note-id]').length`,
    ),
    noteCountBeforeFilter,
    'Task tag filters must not hide quick notes',
  )

  // Reordering a filtered subset must preserve the hidden task's position slot.
  await runIn(
    mainWindow,
    `window.__daylineQa.key(
      '[data-reorder-kind="task"][data-reorder-id="qa-task-a"]',
      'ArrowDown',
      { altKey: true },
    )`,
  )
  await waitForRenderer(
    mainWindow,
    `JSON.stringify(window.__daylineQa.scheduleIds())
      === JSON.stringify(['qa-task-b', 'qa-task-a'])`,
    'filtered task keyboard reorder',
  )
  await reloadRenderer(widgetWindow)
  await waitForRenderer(
    widgetWindow,
    `JSON.stringify([...document.querySelectorAll(
      '[data-qa="widget-schedule"] .widget-task-list > [data-task-id]',
    )].map((row) => row.dataset.taskId))
      === JSON.stringify(['qa-task-b', 'qa-task-c', 'qa-task-a'])`,
    'widget ignores main tag filter and preserves hidden task slot',
  )
  assert.equal(
    await runIn(
      widgetWindow,
      `Boolean(document.querySelector(
        '[data-qa="widget-quick-notes"] [data-daily-note-id="${quickNoteId}"]',
      ))
        && document.querySelectorAll(
          '[data-qa="widget-schedule"] [data-task-id="qa-task-a"] [data-subtask-id]',
        ).length === ${originalDetail.subTaskCount + 2}`,
    ),
    true,
    'Widget must show quick notes and parent children',
  )
  await runIn(mainWindow, `window.__daylineQa.clickButtonText('[data-qa="filter-panel"]', '필터 초기화')`)
  await waitForRenderer(
    mainWindow,
    `JSON.stringify(window.__daylineQa.scheduleIds())
      === JSON.stringify(['qa-task-b', 'qa-task-c', 'qa-task-a'])`,
    'full order after clearing filtered reorder',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="태그 필터 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="filter-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="filters"]')`,
    'filter close and trigger focus restoration',
  )

  await runIn(
    widgetWindow,
    `document.querySelector(
      '[data-qa="widget-quick-notes"] [data-daily-note-id="${quickNoteId}"] .note-check',
    )?.click()`,
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-daily-note-id="${quickNoteId}"]')
      ?.classList.contains('is-completed')`,
    'widget quick-note toggle persisted to main',
  )
  await runIn(
    widgetWindow,
    `document.querySelector(
      '[data-qa="widget-quick-notes"] [data-daily-note-id="${quickNoteId}"] .note-check',
    )?.click()`,
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"]')
      ?.classList.contains('is-completed')`,
    'widget quick-note retoggle persisted',
  )

  const widgetChildId = await runIn(
    widgetWindow,
    `document.querySelector(
      '[data-qa="widget-schedule"] [data-task-id="qa-task-a"] [data-subtask-id]',
    )?.dataset.subtaskId`,
  )
  assert.ok(widgetChildId, 'Widget needs a child toggle target')
  await runIn(
    widgetWindow,
    `document.querySelector(
      '[data-qa="widget-schedule"] [data-subtask-id="${widgetChildId}"] .subtask-toggle',
    )?.click()`,
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector(
      '[data-qa="schedule-section"] [data-subtask-id="${widgetChildId}"]',
    )?.classList.contains('is-completed')
      && !document.querySelector(
        '[data-qa="schedule-section"] [data-task-id="qa-task-a"]',
      )?.classList.contains('is-completed')`,
    'widget child toggle and parent aggregate persisted to main',
  )
  await reloadRenderer(widgetWindow)
  await runIn(
    widgetWindow,
    `document.querySelector(
      '[data-qa="widget-schedule"] [data-subtask-id="${widgetChildId}"] .subtask-toggle',
    )?.click()`,
  )
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector(
      '[data-qa="schedule-section"] [data-task-id="qa-task-a"]',
    )?.classList.contains('is-completed')`,
    'widget child retoggle recompletes parent',
  )

  qaStage = 'recovery-bottom-dialog'
  assert.deepEqual(
    await runIn(mainWindow, `(() => {
      const action = document.querySelector('[data-rail-action="recovery"]')
      return {
        label: action?.getAttribute('aria-label'),
        text: action?.textContent?.trim() ?? null,
        badge: Boolean(action?.querySelector('.nav-badge')),
      }
    })()`),
    { label: '최근 삭제', text: '', badge: false },
    'Empty recent-deletion action must not announce or paint a zero count',
  )
  await sleep(780)
  await runIn(
    mainWindow,
    `window.__daylineQa.contextMenu(document.querySelector(
      '.calendar-task-segment[data-task-id="qa-span-cross"] .calendar-task-main',
    ))`,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.calendar-task-segment[data-task-id="qa-span-cross"]')
      && document.querySelector('[data-rail-action="recovery"]')?.getAttribute('aria-label') === '최근 삭제'
      && !document.querySelector('[data-rail-action="recovery"] .nav-badge')`,
    'deleted task remains recoverable without a numeric rail badge',
  )
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.focus()
  await sleep(80)
  await runIn(mainWindow, `(() => {
    const trigger = document.querySelector('[data-rail-action="recovery"]')
    trigger?.focus()
    trigger?.click()
    return Boolean(trigger)
  })()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('.recovery-layer')?.classList.contains('is-open')
      && document.querySelector('[data-rail-action="recovery"]')?.getAttribute('aria-expanded') === 'true'`,
    'open modal recovery layer',
  )
  const recoveryOpenState = await runIn(mainWindow, `(() => {
    const panel = document.querySelector('[data-qa="recovery-panel"]')
    const layer = document.querySelector('.recovery-layer')
    const close = panel?.querySelector('header .icon-button')
    const closeStyle = close ? getComputedStyle(close) : null
    return {
      role: panel?.getAttribute('role'),
      ariaModal: panel?.getAttribute('aria-modal'),
      labelledBy: panel?.getAttribute('aria-labelledby'),
      layerClass: layer?.className,
      layerAriaHidden: layer?.getAttribute('aria-hidden'),
      layerVisibility: layer ? getComputedStyle(layer).visibility : null,
      triggerExpanded: document.querySelector('[data-rail-action="recovery"]')
        ?.getAttribute('aria-expanded'),
      activeTag: document.activeElement?.tagName,
      activeClass: document.activeElement?.className,
      activeLabel: document.activeElement?.getAttribute('aria-label'),
      closeFocused: document.activeElement === close,
      documentFocused: document.hasFocus(),
      panelInert: panel?.inert,
      closeInertAncestor: close?.closest('[inert]')?.className ?? null,
      closeDisabled: close?.disabled,
      closeTabIndex: close?.tabIndex,
      closeRects: close?.getClientRects().length,
      closeVisibility: closeStyle?.visibility,
      closeDisplay: closeStyle?.display,
      inert: Object.fromEntries(['.side-rail', '.calendar-workspace', '.day-panel']
        .map((selector) => [selector, document.querySelector(selector)?.inert])),
    }
  })()`)
  assert.deepEqual(
    {
      role: recoveryOpenState.role,
      ariaModal: recoveryOpenState.ariaModal,
      labelledBy: recoveryOpenState.labelledBy,
      closeFocused: recoveryOpenState.closeFocused,
      inert: recoveryOpenState.inert,
    },
    {
      role: 'dialog',
      ariaModal: 'true',
      labelledBy: 'recovery-title',
      closeFocused: true,
      inert: { '.side-rail': true, '.calendar-workspace': true, '.day-panel': true },
    },
    `Recovery modal state mismatch: ${JSON.stringify(recoveryOpenState)}`,
  )
  const recoveryAccessibility = await runIn(mainWindow, `(() => {
    const dialog = document.querySelector('[data-qa="recovery-panel"]')
    const close = dialog?.querySelector('header .icon-button')
    const restore = dialog?.querySelector('.restore-button')
    const scrim = document.querySelector('.recovery-scrim')
    if (!dialog || !close || !restore || !scrim) return null
    close.focus()
    close.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }))
    return {
      wrappedBackward: document.activeElement === restore,
      scrimFocusable: scrim.matches('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      scrimAriaHidden: scrim.getAttribute('aria-hidden'),
      itemTitle: dialog.querySelector('.recovery-item strong')?.textContent,
    }
  })()`)
  assert.ok(recoveryAccessibility, 'Recovery dialog must contain a restorable task and focus controls')
  assert.equal(recoveryAccessibility.wrappedBackward, true, 'Shift+Tab must wrap inside recovery')
  assert.equal(recoveryAccessibility.scrimFocusable, false, 'Recovery scrim must not enter keyboard order')
  assert.equal(recoveryAccessibility.scrimAriaHidden, 'true')
  assert.equal(recoveryAccessibility.itemTitle, 'QA cross-week span')
  await runIn(
    mainWindow,
    `document.querySelector('[data-qa="recovery-panel"] .restore-button')?.click()`,
  )
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('.calendar-task-segment[data-task-id="qa-span-cross"]'))
      && !document.querySelector('[data-rail-action="recovery"] .nav-badge')
      && document.activeElement === document.querySelector(
        '[data-qa="recovery-panel"] header .icon-button',
      )`,
    'recovery restore and retained dialog focus',
  )
  assert.equal(
    await runIn(
      mainWindow,
      `window.__daylineQa.key('[data-qa="recovery-panel"] header .icon-button', 'Escape')`,
    ),
    true,
  )
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('.recovery-layer')?.classList.contains('is-open')
      && document.querySelector('[data-rail-action="recovery"]')?.getAttribute('aria-expanded') === 'false'
      && document.activeElement === document.querySelector('[data-rail-action="recovery"]')
      && ['.side-rail', '.calendar-workspace', '.day-panel']
        .every((selector) => document.querySelector(selector)?.inert === false)`,
    'recovery Escape close, inert release, and trigger focus restoration',
  )

  qaStage = 'reload-and-capture'
  // Reload the isolated renderer to prove browser-store persistence before the feature capture.
  await reloadRenderer(mainWindow)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-daily-note-id="${quickNoteId}"]')?.classList.contains('is-completed')
      && document.querySelectorAll(
        '[data-qa="schedule-section"] .task-row[data-task-id="${editableTask.id}"] [data-subtask-id]',
      ).length === ${originalDetail.subTaskCount + 2}`,
    'daily-note and subtask persistence after reload',
  )
  const featureCoverage = await runIn(mainWindow, `(() => {
    const root = document.querySelector('#root')?.getBoundingClientRect()
    const shell = document.querySelector('.main-shell')?.getBoundingClientRect()
    if (!root || !shell) return null
    return {
      rootRight: root.right,
      rootBottom: root.bottom,
      shellRight: shell.right,
      shellBottom: shell.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    }
  })()`)
  assert.ok(featureCoverage, 'Feature layout coverage must be measurable')
  assert.ok(
    Math.abs(featureCoverage.rootRight - featureCoverage.viewportWidth) <= 1
      && Math.abs(featureCoverage.rootBottom - featureCoverage.viewportHeight) <= 1
      && Math.abs(featureCoverage.shellRight - featureCoverage.viewportWidth) <= 1
      && Math.abs(featureCoverage.shellBottom - featureCoverage.viewportHeight) <= 1,
    `120% layout must cover the viewport: ${JSON.stringify(featureCoverage)}`,
  )
  mainWindow.showInactive()
  const featureSize = mainWindow.getSize()
  mainWindow.setSize(featureSize[0] - 1, featureSize[1])
  await sleep(30)
  mainWindow.setSize(featureSize[0], featureSize[1])
  mainWindow.webContents.invalidate?.()
  await runIn(
    mainWindow,
    `new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve(true))))`,
  )
  await sleep(180)
  let featureImage = await mainWindow.webContents.capturePage()
  if (!imageHasVisualDetail(featureImage)) {
    mainWindow.webContents.invalidate?.()
    await sleep(180)
    featureImage = await mainWindow.webContents.capturePage()
  }
  assert.equal(
    imageHasVisualDetail(featureImage),
    true,
    'Feature screenshot must contain rendered UI rather than a blank compositor frame',
  )
  fs.writeFileSync(path.join(outputDir, 'main-window-features.png'), featureImage.toPNG())

  // Stress the true minimum size at the maximum supported UI scale.
  await runIn(mainWindow, `document.querySelector('[data-rail-action="appearance"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="appearance-panel"] [data-qa="font-scale"]'))`,
    'appearance settings before maximum-scale layout QA',
  )
  await runIn(
    mainWindow,
    `window.__daylineQa.setValue('[data-qa="appearance-panel"] [data-qa="font-scale"]', '1.5')`,
  )
  await waitForRenderer(
    mainWindow,
    `getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim() === '15px'`,
    'maximum font scale',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="화면 설정 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="appearance-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="appearance"]')`,
    'maximum-scale appearance close focus restoration',
  )

  // The app's configured minimum window size must keep both sidebar panes usable.
  mainWindow.setSize(1050, 680)
  await sleep(180)
  await waitForRenderer(
    mainWindow,
    `Number(document.querySelector('.calendar-grid')?.dataset.maxLanes) <= 2`,
    'responsive calendar lane capacity at minimum size',
  )
  const minimumLayout = await runIn(mainWindow, `
    (() => {
      const panel = document.querySelector('.day-panel')?.getBoundingClientRect()
      const body = document.querySelector('.day-panel-body')?.getBoundingClientRect()
      const quick = document.querySelector('[data-qa="quick-note-section"]')?.getBoundingClientRect()
      const schedule = document.querySelector('[data-qa="schedule-section"]')?.getBoundingClientRect()
      const add = document.querySelector('[aria-label="선택한 날짜에 퀵 노트 추가"]')
        ?.getBoundingClientRect()
      const headerAdd = document.querySelector('.header-add')?.getBoundingClientRect()
      const workspace = document.querySelector('.calendar-workspace')?.getBoundingClientRect()
      const splitter = document.querySelector('[data-qa="sidebar-splitter"]')?.getBoundingClientRect()
      const root = document.querySelector('#root')?.getBoundingClientRect()
      const shell = document.querySelector('.main-shell')?.getBoundingClientRect()
      const noteList = document.querySelector('.daily-note-list')
      const taskList = document.querySelector('[data-qa="schedule-section"] .day-task-list')
      const calendarGrid = document.querySelector('.calendar-grid')
      const calendarCells = [...document.querySelectorAll('.calendar-grid > .calendar-cell[data-date]')]
      const rail = document.querySelector('.side-rail')
      const primaryRailActions = [...document.querySelectorAll(
        '.side-rail > nav [data-rail-action]',
      )]
      const recoveryRailAction = document.querySelector(
        '.side-rail > .rail-bottom [data-rail-action="recovery"]',
      )
      const updateRailAction = document.querySelector(
        '.side-rail > .rail-bottom [data-rail-action="updates"]',
      )
      const helpRailAction = document.querySelector(
        '.side-rail > .rail-bottom [data-rail-action="help"]',
      )
      if (
        !panel || !body || !quick || !schedule || !add || !headerAdd
        || !workspace || !splitter || !root || !shell || !noteList || !taskList
        || !calendarGrid || calendarCells.length !== 42 || !rail
        || primaryRailActions.length !== 4 || !updateRailAction || !recoveryRailAction || !helpRailAction
      ) return null
      const rect = (element) => {
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        }
      }
      const rowBounds = Array.from({ length: 6 }, (_, row) => {
        const bounds = calendarCells.slice(row * 7, row * 7 + 7).map(rect)
        return {
          row,
          left: Math.min(...bounds.map((item) => item.left)),
          right: Math.max(...bounds.map((item) => item.right)),
          top: Math.min(...bounds.map((item) => item.top)),
          bottom: Math.max(...bounds.map((item) => item.bottom)),
        }
      })
      const maxLanes = Number(calendarGrid.dataset.maxLanes)
      const segments = [...document.querySelectorAll(
        '[data-qa="calendar-task-layout"] .calendar-task-segment[data-task-id]',
      )].map((segment) => {
        const row = Number(segment.dataset.weekRow)
        const lane = Number(segment.dataset.lane)
        const bounds = rect(segment)
        const week = rowBounds[row]
        return {
          taskId: segment.dataset.taskId,
          row,
          lane,
          bounds,
          withinWeek: Boolean(week)
            && bounds.top >= week.top - 1
            && bounds.bottom <= week.bottom + 1
            && bounds.left >= week.left - 1
            && bounds.right <= week.right + 1,
          noNextRowOverlap: !rowBounds[row + 1]
            || bounds.bottom <= rowBounds[row + 1].top + 1,
          validLane: Number.isInteger(lane) && lane >= 0 && lane < maxLanes,
        }
      })
      const overflows = [...document.querySelectorAll(
        '.calendar-cell .calendar-task-overflow[data-date][data-hidden-count]',
      )].map((overflow) => {
        const cell = overflow.closest('.calendar-cell[data-date]')
        const cellIndex = calendarCells.indexOf(cell)
        const row = Math.floor(cellIndex / 7)
        const bounds = rect(overflow)
        const cellBounds = cell ? rect(cell) : null
        const week = rowBounds[row]
        return {
          date: overflow.dataset.date,
          hiddenCount: Number(overflow.dataset.hiddenCount),
          row,
          bounds,
          withinWeek: Boolean(week)
            && bounds.top >= week.top - 1
            && bounds.bottom <= week.bottom + 1
            && bounds.left >= week.left - 1
            && bounds.right <= week.right + 1,
          withinCell: Boolean(cellBounds)
            && bounds.top >= cellBounds.top - 1
            && bounds.bottom <= cellBounds.bottom + 1
            && bounds.left >= cellBounds.left - 1
            && bounds.right <= cellBounds.right + 1,
          noNextRowOverlap: !rowBounds[row + 1]
            || bounds.bottom <= rowBounds[row + 1].top + 1,
        }
      })
      return {
        viewport: { width: innerWidth, height: innerHeight },
        fontToken: getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim(),
        coverageRects: {
          root: { right: root.right, bottom: root.bottom },
          shell: { right: shell.right, bottom: shell.bottom },
        },
        viewportCovered: Math.abs(root.right - innerWidth) <= 1
          && Math.abs(root.bottom - innerHeight) <= 1
          && Math.abs(shell.right - innerWidth) <= 1
          && Math.abs(shell.bottom - innerHeight) <= 1,
        usable: quick.height >= 100 && schedule.height >= 100,
        separated: quick.bottom <= schedule.top,
        contained: quick.left >= panel.left && schedule.right <= panel.right
          && schedule.bottom <= body.bottom + 1,
        columnsSeparated: workspace.right <= panel.left + 1,
        splitterVisible: splitter.top >= body.top && splitter.bottom <= body.bottom,
        addVisible: add.left >= panel.left && add.right <= panel.right && add.bottom <= panel.bottom,
        headerAddVisible: headerAdd.left >= 0 && headerAdd.right <= innerWidth
          && headerAdd.top >= 0 && headerAdd.bottom <= innerHeight,
        independentScroll: ['auto', 'scroll'].includes(getComputedStyle(noteList).overflowY)
          && ['auto', 'scroll'].includes(getComputedStyle(taskList).overflowY),
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
          && document.documentElement.scrollHeight <= innerHeight + 1,
        calendarGeometry: {
          maxLanes,
          segmentCount: segments.length,
          overflowCount: overflows.length,
          invalidSegments: segments.filter((segment) =>
            !segment.withinWeek || !segment.noNextRowOverlap || !segment.validLane),
          invalidOverflows: overflows.filter((overflow) =>
            !overflow.withinWeek || !overflow.withinCell || !overflow.noNextRowOverlap
              || overflow.hiddenCount < 1),
        },
        railGeometry: (() => {
          const railBounds = rect(rail)
          const actions = [...primaryRailActions, updateRailAction, recoveryRailAction, helpRailAction].map((button) => ({
            action: button.dataset.railAction,
            bounds: rect(button),
          }))
          const orderedByTop = [...actions].sort((left, right) => left.bounds.top - right.bounds.top)
          return {
            railBounds,
            actions,
            allContained: actions.every(({ bounds }) =>
              bounds.left >= railBounds.left - 1
              && bounds.right <= railBounds.right + 1
              && bounds.top >= railBounds.top - 1
              && bounds.bottom <= railBounds.bottom + 1
              && bounds.left >= -1
              && bounds.right <= innerWidth + 1
              && bounds.top >= -1
              && bounds.bottom <= innerHeight + 1),
            noOverlap: orderedByTop.every((action, index) => index === 0
              || orderedByTop[index - 1].bounds.bottom <= action.bounds.top + 1),
            recoveryBelowPrimary: recoveryRailAction.getBoundingClientRect().top
              >= primaryRailActions.at(-1).getBoundingClientRect().bottom,
            updateBelowPrimary: updateRailAction.getBoundingClientRect().top
              >= primaryRailActions.at(-1).getBoundingClientRect().bottom,
            recoveryBelowUpdate: recoveryRailAction.getBoundingClientRect().top
              >= updateRailAction.getBoundingClientRect().bottom,
            helpBelowRecovery: helpRailAction.getBoundingClientRect().top
              >= recoveryRailAction.getBoundingClientRect().bottom,
            helpNearBottom: railBounds.bottom
              - helpRailAction.getBoundingClientRect().bottom <= 32,
          }
        })(),
      }
    })()
  `)
  assert.ok(minimumLayout, 'Minimum-size sidebar elements must render')
  assert.equal(minimumLayout.fontToken, '15px', 'Minimum-size QA must run at 150% font scale')
  assert.equal(
    minimumLayout.viewportCovered,
    true,
    `150% layout must cover the minimum viewport: ${JSON.stringify(minimumLayout)}`,
  )
  assert.equal(minimumLayout.usable, true, 'Both sidebar halves need usable minimum height')
  assert.equal(minimumLayout.separated, true, 'Sidebar halves must not overlap')
  assert.equal(minimumLayout.contained, true, 'Sidebar sections must remain inside the panel')
  assert.equal(minimumLayout.columnsSeparated, true, 'Calendar and sidebar columns must not overlap')
  assert.equal(minimumLayout.splitterVisible, true, 'Main splitter must stay visible at minimum size')
  assert.equal(minimumLayout.addVisible, true, 'Quick-note add must stay visible at minimum size')
  assert.equal(minimumLayout.headerAddVisible, true, 'New-task button must stay visible at minimum size')
  assert.equal(minimumLayout.independentScroll, true, 'Each sidebar half needs independent scrolling')
  assert.equal(minimumLayout.noPageOverflow, true, 'Minimum-size layout must not overflow the page')
  assert.ok(
    minimumLayout.calendarGeometry.maxLanes >= 1
      && minimumLayout.calendarGeometry.maxLanes <= 2,
    `Minimum calendar must reduce to at most two lanes: ${JSON.stringify(minimumLayout.calendarGeometry)}`,
  )
  assert.ok(
    minimumLayout.calendarGeometry.segmentCount > 0,
    'Minimum-size geometry QA requires visible connected calendar segments',
  )
  assert.ok(
    minimumLayout.calendarGeometry.overflowCount > 0,
    'Minimum-size geometry QA requires a real hidden-task overflow indicator',
  )
  assert.deepEqual(
    minimumLayout.calendarGeometry.invalidSegments,
    [],
    `Every segment must remain inside its week row: ${JSON.stringify(minimumLayout.calendarGeometry)}`,
  )
  assert.deepEqual(
    minimumLayout.calendarGeometry.invalidOverflows,
    [],
    `Every overflow marker must remain inside its cell and week row: ${JSON.stringify(minimumLayout.calendarGeometry)}`,
  )
  assert.deepEqual(
    minimumLayout.railGeometry.actions.map((item) => item.action),
    ['templates', 'filters', 'tags', 'appearance', 'updates', 'recovery', 'help'],
    'Minimum-size rail must preserve its semantic action order',
  )
  assert.equal(
    minimumLayout.railGeometry.allContained,
    true,
    `Every rail action must remain in the 1050x680 viewport: ${JSON.stringify(minimumLayout.railGeometry)}`,
  )
  assert.equal(minimumLayout.railGeometry.noOverlap, true, 'Minimum-size rail actions must not overlap')
  assert.equal(minimumLayout.railGeometry.updateBelowPrimary, true)
  assert.equal(minimumLayout.railGeometry.recoveryBelowPrimary, true)
  assert.equal(minimumLayout.railGeometry.recoveryBelowUpdate, true)
  assert.equal(minimumLayout.railGeometry.helpBelowRecovery, true, 'Help must remain below recovery')
  assert.equal(minimumLayout.railGeometry.helpNearBottom, true, 'Help must remain anchored at rail bottom')
  console.log(
    `Minimum calendar overlay: lanes=${minimumLayout.calendarGeometry.maxLanes}, `
      + `segments=${minimumLayout.calendarGeometry.segmentCount}, `
      + `overflows=${minimumLayout.calendarGeometry.overflowCount}`,
  )

  qaStage = 'minimum-rail-collapse-and-template-hit-test'
  await runIn(mainWindow, `document.querySelector('[data-qa="rail-brand-toggle"]')?.click()`)
  await sleep(240)
  const minimumCollapsedRail = await waitForRenderer(mainWindow, `(() => {
    const shell = document.querySelector('.main-shell')
    const rail = document.querySelector('[data-qa="side-rail"]')
    const toggle = document.querySelector('[data-qa="rail-open-button"]')
    const workspace = document.querySelector('.calendar-workspace')
    const panel = document.querySelector('.day-panel')
    const headerAdd = document.querySelector('.header-add')
    const quickAdd = document.querySelector('[data-qa="quick-note-section"] [data-qa="quick-note-add"]')
    if (!shell || !rail || !toggle || !workspace || !panel || !headerAdd || !quickAdd) return null
    const rect = (element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    }
    const railRect = rect(rail)
    const toggleRect = rect(toggle)
    const workspaceRect = rect(workspace)
    const panelRect = rect(panel)
    const headerAddRect = rect(headerAdd)
    const quickAddRect = rect(quickAdd)
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scaleToken: getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim(),
      state: rail.dataset.state,
      collapsed: shell.dataset.railCollapsed,
      expanded: toggle.getAttribute('aria-expanded'),
      railHidden: rail.hidden,
      rail: railRect,
      toggle: toggleRect,
      workspace: workspaceRect,
      panel: panelRect,
      toggleContained: toggleRect.left >= workspaceRect.left - 1
        && toggleRect.right <= workspaceRect.right + 1
        && toggleRect.top >= -1
        && toggleRect.bottom <= innerHeight + 1,
      columnsSeparated: workspaceRect.left >= railRect.right - 1
        && workspaceRect.right <= panelRect.left + 1,
      coreControlsVisible: [headerAddRect, quickAddRect].every((bounds) =>
        bounds.left >= -1 && bounds.right <= innerWidth + 1
        && bounds.top >= -1 && bounds.bottom <= innerHeight + 1),
      noFlyout: !document.querySelector('.rail-flyout'),
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
        && document.documentElement.scrollHeight <= innerHeight + 1,
    }
  })()`, 'minimum collapsed rail geometry')
  assert.deepEqual(
    {
      scaleToken: minimumCollapsedRail.scaleToken,
      state: minimumCollapsedRail.state,
      collapsed: minimumCollapsedRail.collapsed,
      expanded: minimumCollapsedRail.expanded,
      railHidden: minimumCollapsedRail.railHidden,
      toggleContained: minimumCollapsedRail.toggleContained,
      columnsSeparated: minimumCollapsedRail.columnsSeparated,
      coreControlsVisible: minimumCollapsedRail.coreControlsVisible,
      noFlyout: minimumCollapsedRail.noFlyout,
      noPageOverflow: minimumCollapsedRail.noPageOverflow,
    },
    {
      scaleToken: '15px',
      state: 'closed',
      collapsed: 'true',
      expanded: 'false',
      railHidden: true,
      toggleContained: true,
      columnsSeparated: true,
      coreControlsVisible: true,
      noFlyout: true,
      noPageOverflow: true,
    },
    `1050x680 @150% rail collapse must stay contained: ${JSON.stringify(minimumCollapsedRail)}`,
  )
  await runIn(mainWindow, `document.querySelector('[data-qa="rail-open-button"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `document.querySelector('[data-qa="side-rail"]')?.dataset.state === 'open'
      && !document.querySelector('[data-qa="side-rail"]')?.hidden
      && document.activeElement === document.querySelector('[data-qa="rail-brand-toggle"]')`,
    'minimum rail reopened',
  )

  await runIn(mainWindow, `document.querySelector('[data-rail-action="templates"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `Boolean(document.querySelector('[data-qa="template-panel"] [data-template-id="qa-template-seed"]'))
      && !document.querySelector('[data-qa="template-modal"]')`,
    'minimum template flyout with hidden create form',
  )
  const minimumTemplatePanel = await runIn(mainWindow, `(() => {
    const panel = document.querySelector('[data-qa="template-panel"]')
    const close = panel?.querySelector('[aria-label="반복 일정 닫기"]')
    const toggle = panel?.querySelector('[data-qa="template-form-toggle"]')
    const list = panel?.querySelector('[data-qa="template-list"]')
    if (!panel || !close || !toggle || !list) return null
    const rect = (element) => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    }
    const panelRect = rect(panel)
    return {
      panel: panelRect,
      close: rect(close),
      toggle: rect(toggle),
      contained: panelRect.left >= -1 && panelRect.right <= innerWidth + 1
        && panelRect.top >= -1 && panelRect.bottom <= innerHeight + 1,
      controlsContained: [close, toggle].every((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= panelRect.left - 1 && bounds.right <= panelRect.right + 1
          && bounds.top >= panelRect.top - 1 && bounds.bottom <= panelRect.bottom + 1
      }),
      scrollable: ['auto', 'scroll'].includes(getComputedStyle(list.parentElement).overflowY),
      noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
        && document.documentElement.scrollHeight <= innerHeight + 1,
    }
  })()`)
  assert.ok(minimumTemplatePanel, 'Minimum template flyout geometry must be measurable')
  assert.deepEqual(
    {
      contained: minimumTemplatePanel.contained,
      controlsContained: minimumTemplatePanel.controlsContained,
      scrollable: minimumTemplatePanel.scrollable,
      noPageOverflow: minimumTemplatePanel.noPageOverflow,
    },
    { contained: true, controlsContained: true, scrollable: true, noPageOverflow: true },
    `Template flyout must stay usable at 1050x680 @150%: ${JSON.stringify(minimumTemplatePanel)}`,
  )
  const minimumTaskCountBeforeFlyoutDrops = await runIn(
    mainWindow,
    `JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')?.tasks?.length ?? -1`,
  )
  const sundayTemplateDrop = await dragTemplateToCalendarNative(
    mainWindow,
    'qa-template-seed',
    '2026-08-02',
  )
  assert.ok(sundayTemplateDrop, 'Template copy must reach the Sunday calendar cell')
  assert.equal(sundayTemplateDrop.inputPath, 'Input.dispatchMouseEvent')
  const sundayDragState = sundayTemplateDrop.during
  assert.equal(sundayDragState.connected, true)
  assert.equal(sundayDragState.dragging, 'true')
  assert.equal(sundayDragState.pointerEvents, 'none')
  assert.equal(sundayDragState.opacity, '0')
  assert.equal(sundayDragState.inert, false)
  assert.equal(sundayDragState.ariaHidden, 'true')
  assert.equal(sundayTemplateDrop.during.hitDate, '2026-08-02')
  assert.equal(sundayTemplateDrop.during.hitInsidePanel, false)
  assert.equal(sundayTemplateDrop.during.trace.dragstart.templateId, 'qa-template-seed')
  assert.deepEqual({
    connected: sundayTemplateDrop.after.connected,
    dragging: sundayTemplateDrop.after.dragging,
    pointerEvents: sundayTemplateDrop.after.pointerEvents,
    expanded: sundayTemplateDrop.after.expanded,
  }, {
    connected: true,
    dragging: null,
    pointerEvents: 'auto',
    expanded: 'true',
  }, 'Template flyout must visibly reopen after the native Sunday drop')
  assert.equal(sundayTemplateDrop.after.trace.dragover?.date, '2026-08-02')
  assert.equal(sundayTemplateDrop.after.trace.drop?.date, '2026-08-02')
  assert.ok(sundayTemplateDrop.after.trace.drop?.types.includes('application/x-dayline-template'))
  assert.ok(
    sundayTemplateDrop.after.trace.dragend?.at >= sundayTemplateDrop.after.trace.drop?.at,
    `Native Sunday drop must precede dragend: ${JSON.stringify(sundayTemplateDrop.after.trace)}`,
  )
  const mondayTemplateDrop = await dragTemplateToCalendarNative(
    mainWindow,
    'qa-template-secondary',
    '2026-08-03',
  )
  assert.ok(mondayTemplateDrop, 'Template copy must reach the Monday calendar cell')
  assert.equal(mondayTemplateDrop.inputPath, 'Input.dispatchMouseEvent')
  const mondayDragState = mondayTemplateDrop.during
  assert.equal(mondayDragState.connected, true)
  assert.equal(mondayDragState.dragging, 'true')
  assert.equal(mondayDragState.pointerEvents, 'none')
  assert.equal(mondayDragState.opacity, '0')
  assert.equal(mondayDragState.inert, false)
  assert.equal(mondayDragState.ariaHidden, 'true')
  assert.ok(
    mondayTemplateDrop.during.hitDate === '2026-08-03' || mondayTemplateDrop.during.hitTaskId,
    `Monday target must hit either its cell or an existing connected task bar: ${JSON.stringify(mondayTemplateDrop.during)}`,
  )
  assert.equal(mondayTemplateDrop.during.hitInsidePanel, false)
  assert.deepEqual({
    connected: mondayTemplateDrop.after.connected,
    dragging: mondayTemplateDrop.after.dragging,
    pointerEvents: mondayTemplateDrop.after.pointerEvents,
    expanded: mondayTemplateDrop.after.expanded,
  }, {
    connected: true,
    dragging: null,
    pointerEvents: 'auto',
    expanded: 'true',
  }, 'Template flyout must visibly reopen after the native Monday drop')
  assert.ok(
    mondayTemplateDrop.after.trace.dragover?.date === '2026-08-03'
      || mondayTemplateDrop.after.trace.dragover?.taskId,
    'Monday dragover must reach either the date cell or its task-bar overlay',
  )
  assert.ok(
    mondayTemplateDrop.after.trace.drop?.date === '2026-08-03'
      || mondayTemplateDrop.after.trace.drop?.taskId,
    'Monday drop must reach either the date cell or its task-bar overlay',
  )
  assert.ok(mondayTemplateDrop.after.trace.drop?.types.includes('application/x-dayline-template'))
  assert.ok(
    mondayTemplateDrop.after.trace.dragend?.at >= mondayTemplateDrop.after.trace.drop?.at,
    `Native Monday drop must precede dragend: ${JSON.stringify(mondayTemplateDrop.after.trace)}`,
  )
  console.log('Native template DnD: Sunday cell and Monday task-bar overlay passed')
  await waitForRenderer(
    mainWindow,
    `(() => {
      const store = JSON.parse(localStorage.getItem('dayline-browser-store-v1') || 'null')
      const active = (store?.tasks ?? []).filter((task) => !task.deletedAt)
      return (store?.tasks?.length ?? -1) === ${minimumTaskCountBeforeFlyoutDrops + 2}
        && active.some((task) => task.title === 'QA 3일 템플릿'
          && task.startDate === '2026-08-02' && task.dueDate === '2026-08-04')
        && active.some((task) => task.title === 'QA 보조 템플릿'
          && task.startDate === '2026-08-03' && task.dueDate === '2026-08-03')
        && !document.querySelector('[data-qa="task-modal"]')
    })()`,
    'Sunday and Monday flyout-retracted template drops',
  )
  await runIn(mainWindow, `document.querySelector('[aria-label="반복 일정 닫기"]')?.click()`)
  await waitForRenderer(
    mainWindow,
    `!document.querySelector('[data-qa="template-panel"]')
      && document.activeElement === document.querySelector('[data-rail-action="templates"]')`,
    'minimum template panel close after hit-tested drops',
  )

  const inspectMinimumRailPanel = async (action, qa, closeLabel) => {
    await runIn(
      mainWindow,
      `document.querySelector('[data-rail-action="${action}"]')?.click()`,
    )
    await waitForRenderer(
      mainWindow,
      `Boolean(document.querySelector('[data-qa="${qa}"]'))
        && document.querySelector('[data-rail-action="${action}"]')
          ?.getAttribute('aria-expanded') === 'true'
        && document.activeElement === document.querySelector(${JSON.stringify(`[aria-label="${closeLabel}"]`)})`,
      `minimum ${action} panel`,
    )
    await runIn(
      mainWindow,
      `new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve(true))))`,
    )
    const layout = await runIn(mainWindow, `(() => {
      const rail = document.querySelector('.side-rail')?.getBoundingClientRect()
      const panel = document.querySelector('[data-qa="${qa}"]')?.getBoundingClientRect()
      const close = document.querySelector(${JSON.stringify(`[aria-label="${closeLabel}"]`)})
        ?.getBoundingClientRect()
      const scroll = document.querySelector('[data-qa="${qa}"] .settings-scroll')
      if (!rail || !panel || !close || !scroll) return null
      return {
        viewport: { width: innerWidth, height: innerHeight },
        rail: { left: rail.left, right: rail.right, top: rail.top, bottom: rail.bottom },
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        close: { left: close.left, right: close.right, top: close.top, bottom: close.bottom },
        contained: panel.left >= rail.right - 1
          && panel.right <= innerWidth + 1
          && panel.top >= -1
          && panel.bottom <= innerHeight + 1,
        closeVisible: close.left >= panel.left && close.right <= panel.right
          && close.top >= panel.top && close.bottom <= panel.bottom,
        scrollOverflow: getComputedStyle(scroll).overflowY,
        scrollHeight: scroll.scrollHeight,
        clientHeight: scroll.clientHeight,
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
          && document.documentElement.scrollHeight <= innerHeight + 1,
        hasAppearanceControls: Boolean(document.querySelector(
          '[data-qa="${qa}"] [data-qa="font-scale"]',
        )),
        hasTagControls: Boolean(document.querySelector(
          '[data-qa="${qa}"] [data-qa="new-tag-name"]',
        )),
      }
    })()`)
    assert.ok(layout, `Minimum ${action} panel geometry must be measurable`)
    assert.equal(
      layout.contained,
      true,
      `${action} panel must remain inside the minimum viewport: ${JSON.stringify(layout)}`,
    )
    assert.equal(
      layout.closeVisible,
      true,
      `${action} close control must remain visible: ${JSON.stringify(layout)}`,
    )
    assert.ok(['auto', 'scroll'].includes(layout.scrollOverflow))
    assert.equal(layout.noPageOverflow, true, `${action} panel must not create page overflow`)
    await runIn(mainWindow, `document.querySelector(${JSON.stringify(`[aria-label="${closeLabel}"]`)})?.click()`)
    await waitForRenderer(
      mainWindow,
      `!document.querySelector('[data-qa="${qa}"]')
        && document.activeElement === document.querySelector('[data-rail-action="${action}"]')`,
      `minimum ${action} close focus restoration`,
    )
    return layout
  }
  const minimumAppearancePanel = await inspectMinimumRailPanel(
    'appearance',
    'appearance-panel',
    '화면 설정 닫기',
  )
  assert.equal(minimumAppearancePanel.hasAppearanceControls, true)
  assert.equal(minimumAppearancePanel.hasTagControls, false)
  const minimumTagPanel = await inspectMinimumRailPanel(
    'tags',
    'tag-settings-panel',
    '태그 설정 닫기',
  )
  assert.equal(minimumTagPanel.hasAppearanceControls, false)
  assert.equal(minimumTagPanel.hasTagControls, true)
  assert.ok(
    minimumTagPanel.scrollHeight > minimumTagPanel.clientHeight,
    'The long tag manager must retain independent scrolling at minimum size',
  )
  // The panel is removed synchronously, but Chromium can otherwise hand
  // capturePage the previous compositor frame. Let two paints settle so the
  // generic minimum-window artifact reflects the closed rail state we just
  // asserted in the DOM.
  await runIn(mainWindow, `new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })`)
  await sleep(60)
  const minimumImage = await mainWindow.webContents.capturePage()
  fs.writeFileSync(path.join(outputDir, 'main-window-minimum.png'), minimumImage.toPNG())

  // The compact widget must also reflow at the shared maximum font scale. Test
  // both its normal compact bounds and the smallest supported user resize.
  qaStage = 'widget-minimum-layout'
  await reloadRenderer(widgetWindow)
  await waitForRenderer(
    widgetWindow,
    `getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim() === '15px'
      && document.querySelector('[data-qa="widget-splitter"]')?.getAttribute('aria-valuenow') === '80'`,
    'maximum font scale and split persistence in widget',
  )
  const inspectWidgetLayout = async (width, height) => {
    widgetWindow.setSize(width, height)
    widgetWindow.showInactive()
    widgetWindow.webContents.invalidate?.()
    await sleep(180)
    return runIn(widgetWindow, `(() => {
      const root = document.querySelector('#root')?.getBoundingClientRect()
      const shell = document.querySelector('.widget-shell')?.getBoundingClientRect()
      const body = document.querySelector('.widget-split-body')?.getBoundingClientRect()
      const schedule = document.querySelector('[data-qa="widget-schedule"]')?.getBoundingClientRect()
      const quick = document.querySelector('[data-qa="widget-quick-notes"]')?.getBoundingClientRect()
      const splitter = document.querySelector('[data-qa="widget-splitter"]')?.getBoundingClientRect()
      const close = document.querySelector('.widget-controls button:last-child')?.getBoundingClientRect()
      const taskAdd = document.querySelector('[data-qa="widget-schedule"] .quick-add button')
        ?.getBoundingClientRect()
      const noteAdd = document.querySelector(
        '[data-qa="widget-quick-notes"] [aria-label="선택한 날짜에 퀵 노트 추가"]',
      )?.getBoundingClientRect()
      const taskList = document.querySelector('[data-qa="widget-schedule"] .widget-task-list')
      const noteList = document.querySelector('[data-qa="widget-quick-notes"] .daily-note-list')
      if (!root || !shell || !body || !schedule || !quick || !splitter || !close
        || !taskAdd || !noteAdd || !taskList || !noteList) return null
      const inViewport = (rect) => rect.left >= 0 && rect.top >= 0
        && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
      return {
        viewport: { width: innerWidth, height: innerHeight },
        fontToken: getComputedStyle(document.documentElement).getPropertyValue('--font-10').trim(),
        raw: {
          root: {
            left: root.left,
            top: root.top,
            right: root.right,
            bottom: root.bottom,
            width: root.width,
            height: root.height,
          },
          shell: {
            left: shell.left,
            top: shell.top,
            right: shell.right,
            bottom: shell.bottom,
            width: shell.width,
            height: shell.height,
          },
          documentScroll: {
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          },
          bodyScroll: {
            width: document.body.scrollWidth,
            height: document.body.scrollHeight,
          },
          noteAdd: {
            left: noteAdd.left,
            top: noteAdd.top,
            right: noteAdd.right,
            bottom: noteAdd.bottom,
          },
          quickPane: {
            left: quick.left,
            top: quick.top,
            right: quick.right,
            bottom: quick.bottom,
            height: quick.height,
          },
        },
        rootCovered: Math.abs(root.right - innerWidth) <= 1
          && Math.abs(root.bottom - innerHeight) <= 1,
        shellContained: inViewport(shell),
        panesUsable: schedule.height >= 70 && quick.height >= 24,
        panesSeparated: schedule.bottom <= splitter.top + 1
          && splitter.bottom <= quick.top + 1,
        panesContained: schedule.top >= body.top - 1 && quick.bottom <= body.bottom + 1,
        splitterVisible: splitter.height >= 7 && inViewport(splitter),
        coreButtonsVisible: inViewport(close) && inViewport(taskAdd) && inViewport(noteAdd)
          && noteAdd.top >= quick.top && noteAdd.bottom <= quick.bottom + 1
          && close.width > 0 && taskAdd.width > 0 && noteAdd.width > 0,
        independentScroll: ['auto', 'scroll'].includes(getComputedStyle(taskList).overflowY)
          && ['auto', 'scroll'].includes(getComputedStyle(noteList).overflowY),
        noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1
          && document.documentElement.scrollHeight <= innerHeight + 1,
      }
    })()`)
  }
  const compactWidgetLayout = await inspectWidgetLayout(390, 620)
  assert.ok(compactWidgetLayout, '390x620 widget layout must render')
  const compactWidgetDiagnostic = JSON.stringify(compactWidgetLayout)
  assert.equal(compactWidgetLayout.fontToken, '15px', compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.rootCovered, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.shellContained, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.panesUsable, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.panesSeparated, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.panesContained, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.splitterVisible, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.coreButtonsVisible, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.independentScroll, true, compactWidgetDiagnostic)
  assert.equal(compactWidgetLayout.noPageOverflow, true, compactWidgetDiagnostic)
  const widgetFeatureImage = await widgetWindow.webContents.capturePage()
  assert.equal(imageHasVisualDetail(widgetFeatureImage), true, 'Widget feature capture must not be blank')
  fs.writeFileSync(path.join(outputDir, 'widget-window-features.png'), widgetFeatureImage.toPNG())

  const minimumWidgetLayout = await inspectWidgetLayout(320, 420)
  assert.ok(minimumWidgetLayout, '320x420 widget layout must render')
  const minimumWidgetDiagnostic = JSON.stringify(minimumWidgetLayout)
  assert.equal(minimumWidgetLayout.fontToken, '15px', minimumWidgetDiagnostic)
  assert.equal(
    minimumWidgetLayout.rootCovered,
    true,
    `150% widget root must cover the minimum viewport: ${JSON.stringify(minimumWidgetLayout)}`,
  )
  assert.equal(minimumWidgetLayout.shellContained, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.panesUsable, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.panesSeparated, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.panesContained, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.splitterVisible, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.coreButtonsVisible, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.independentScroll, true, minimumWidgetDiagnostic)
  assert.equal(minimumWidgetLayout.noPageOverflow, true, minimumWidgetDiagnostic)
  widgetWindow.webContents.invalidate?.()
  await sleep(120)
  const minimumWidgetImage = await widgetWindow.webContents.capturePage()
  assert.equal(imageHasVisualDetail(minimumWidgetImage), true, 'Minimum widget capture must not be blank')
  fs.writeFileSync(path.join(outputDir, 'widget-window-minimum.png'), minimumWidgetImage.toPNG())

  // Widget regression: the latest parent detail includes persisted children and state controls.
  widgetWindow.setSize(390, 620)
  await reloadRenderer(widgetWindow)
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector('.task-row[data-task-id="${editableTask.id}"] .task-row-main'))`,
    'persisted parent in widget',
  )
  await runIn(
    widgetWindow,
    `document.querySelector('.task-row[data-task-id="${editableTask.id}"] .task-row-main')?.click()`,
  )
  await waitForRenderer(
    widgetWindow,
    `Boolean(document.querySelector('.task-modal [aria-label="활성 상태 선택"]'))
      && document.querySelectorAll('.task-modal .subtask-edit-row').length
        === ${originalDetail.subTaskCount + 2}`,
    'widget detail state and subtasks',
  )

  destroyQaWindow(mainWindow)
  destroyQaWindow(widgetWindow)
  clearTimeout(qaTimeout)
  app.quit()
}).catch((error) => {
  clearTimeout(qaTimeout)
  console.error(`Capture QA stage: ${qaStage}`)
  console.error(error?.stack || String(error))
  for (const window of BrowserWindow.getAllWindows()) destroyQaWindow(window)
  app.exit(1)
})
