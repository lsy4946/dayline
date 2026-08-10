const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

function waitForLoad(window) {
  return new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve)
    window.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Renderer failed to load (${code}): ${description}`))
    })
  })
}

let qaTimeout

app.whenReady().then(async () => {
  qaTimeout = setTimeout(() => {
    console.error(new Error('Electron QA exceeded 30 seconds'))
    app.exit(1)
  }, 30_000)
  const outputDir = path.join(__dirname, '..', 'qa')
  fs.mkdirSync(outputDir, { recursive: true })
  const rendererPath = path.join(__dirname, '..', 'dist', 'index.html')

  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: '#f4f5f0',
    webPreferences: { backgroundThrottling: false, partition: 'dayline-qa' },
  })
  const widgetWindow = new BrowserWindow({
    width: 390,
    height: 620,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false, partition: 'dayline-qa' },
  })

  const mainLoaded = waitForLoad(mainWindow)
  const widgetLoaded = waitForLoad(widgetWindow)
  await Promise.all([
    mainWindow.loadFile(rendererPath, { query: { mode: 'main' } }),
    widgetWindow.loadFile(rendererPath, { query: { mode: 'widget' } }),
    mainLoaded,
    widgetLoaded,
  ])

  await Promise.all([
    mainWindow.webContents.insertCSS('* { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }'),
    widgetWindow.webContents.insertCSS('* { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }'),
  ])

  await new Promise((resolve) => setTimeout(resolve, 500))
  const [mainImage, widgetImage] = await Promise.all([
    mainWindow.webContents.capturePage(),
    widgetWindow.webContents.capturePage(),
  ])
  fs.writeFileSync(path.join(outputDir, 'main-window.png'), mainImage.toPNG())
  fs.writeFileSync(path.join(outputDir, 'widget-window.png'), widgetImage.toPNG())

  const detailCancelDiscards = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const row = document.querySelector('.task-row:not(.is-completed)')
      const target = row?.querySelector('.task-row-main')
      const originalTitle = row?.querySelector('.task-title')?.textContent
      if (!row || !target || !originalTitle) return resolve(false)
      let originalDate = ''
      let originalNote = ''
      let originalColor = ''
      target.click()

      const waitForDetail = () => {
        const modal = document.querySelector('.task-modal')
        const titleInput = modal?.querySelector('.title-input')
        const dateInput = modal?.querySelector('input[type="date"]')
        const noteInput = modal?.querySelector('textarea')
        const selectedColor = modal?.querySelector('.color-option.is-selected')
        const alternateColor = [...(modal?.querySelectorAll('.color-option') ?? [])]
          .find((button) => !button.classList.contains('is-selected'))
        const stateButtons = modal?.querySelectorAll('.task-state-controls button')
        if (!modal || !titleInput || !dateInput || !noteInput || !selectedColor || !alternateColor || !stateButtons?.[1]) {
          return setTimeout(waitForDetail, 20)
        }

        originalDate = dateInput.value
        originalNote = noteInput.value
        originalColor = selectedColor.getAttribute('aria-label') ?? ''
        const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        const textareaValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        inputValueSetter?.call(titleInput, originalTitle + ' QA 임시 변경')
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        inputValueSetter?.call(dateInput, '2099-12-31')
        dateInput.dispatchEvent(new Event('input', { bubbles: true }))
        textareaValueSetter?.call(noteInput, originalNote + ' QA 임시 메모')
        noteInput.dispatchEvent(new Event('input', { bubbles: true }))
        alternateColor.click()
        stateButtons[1].click()

        const waitForDraft = () => {
          const inactiveButton = document.querySelectorAll('.task-state-controls button')[1]
          const currentDate = document.querySelector('.task-modal input[type="date"]')?.value
          const currentNote = document.querySelector('.task-modal textarea')?.value
          const currentColor = document.querySelector('.task-modal .color-option.is-selected')?.getAttribute('aria-label')
          if (
            inactiveButton?.getAttribute('aria-pressed') !== 'true'
            || currentDate !== '2099-12-31'
            || currentNote !== originalNote + ' QA 임시 메모'
            || currentColor === originalColor
          ) return setTimeout(waitForDraft, 20)
          if (row.classList.contains('is-completed')) return resolve(false)
          document.querySelector('.modal-footer .secondary-button')?.click()

          const waitForClose = () => {
            if (document.querySelector('.task-modal')) return setTimeout(waitForClose, 20)
            if (row.classList.contains('is-completed')) return resolve(false)
            if (row.querySelector('.task-title')?.textContent !== originalTitle) return resolve(false)
            target.click()

            const waitForReopen = () => {
              const reopenedInput = document.querySelector('.task-modal .title-input')
              const reopenedDate = document.querySelector('.task-modal input[type="date"]')
              const reopenedNote = document.querySelector('.task-modal textarea')
              const reopenedColor = document.querySelector('.task-modal .color-option.is-selected')
              const activeButton = document.querySelector('.task-state-controls button')
              if (!reopenedInput || !reopenedDate || !reopenedNote || !reopenedColor || !activeButton) {
                return setTimeout(waitForReopen, 20)
              }
              const discarded = reopenedInput.value === originalTitle
                && reopenedDate.value === originalDate
                && reopenedNote.value === originalNote
                && reopenedColor.getAttribute('aria-label') === originalColor
                && activeButton.getAttribute('aria-pressed') === 'true'
              document.querySelector('.task-modal .icon-button')?.click()
              const waitForFinalClose = () => document.querySelector('.task-modal')
                ? setTimeout(waitForFinalClose, 20)
                : resolve(discarded)
              waitForFinalClose()
            }
            waitForReopen()
          }
          waitForClose()
        }
        waitForDraft()
      }
      waitForDetail()
    })
  `)
  if (!detailCancelDiscards) throw new Error('Detail cancel did not discard content, date, color, and status drafts')
  const activeAdvanced = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const row = document.querySelector('.task-row:not(.is-completed)')
      const target = row?.querySelector('.task-row-main')
      if (!row || !target) return resolve(false)
      window.__daylineQaActiveRow = row
      window.__daylineQaTaskTitle = row.querySelector('.task-title')?.textContent
      window.__daylineQaRowCount = document.querySelectorAll('.task-row').length
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const waitForInactive = () => row.classList.contains('is-completed') ? resolve(true) : setTimeout(waitForInactive, 20)
      waitForInactive()
    })
  `)
  if (!activeAdvanced) throw new Error('Right-click did not deactivate an active task')

  const inactiveDeleted = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      setTimeout(() => {
        const row = window.__daylineQaActiveRow
        const target = row?.querySelector('.task-row-main')
        if (!row || !target) return resolve(false)
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        const waitForRemoval = () => {
          if (document.querySelector('.delete-confirm-dialog')) return resolve(false)
          if (document.querySelectorAll('.task-row').length < window.__daylineQaRowCount) return resolve(true)
          setTimeout(waitForRemoval, 20)
        }
        waitForRemoval()
      }, 760)
    })
  `)
  if (!inactiveDeleted) throw new Error('Right-click did not move an inactive task to recent deletion')

  const inactiveRestored = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const clickUndo = () => {
        const action = document.querySelector('.toast button')
        if (!action) return setTimeout(clickUndo, 20)
        action.click()
        const waitForRestore = () => {
          if (document.querySelectorAll('.task-row').length !== window.__daylineQaRowCount) {
            return setTimeout(waitForRestore, 20)
          }
          const restoredRow = [...document.querySelectorAll('.task-row')].find(
            (row) => row.querySelector('.task-title')?.textContent === window.__daylineQaTaskTitle,
          )
          window.__daylineQaRestoredRow = restoredRow
          resolve(Boolean(restoredRow?.classList.contains('is-completed')))
        }
        waitForRestore()
      }
      clickUndo()
    })
  `)
  if (!inactiveRestored) throw new Error('Right-click deletion could not be undone')

  const detailReactivated = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const row = window.__daylineQaRestoredRow
      row?.querySelector('.task-row-main')?.click()
      const waitForDetail = () => {
        const activeButton = document.querySelector('.task-state-controls button')
        if (!activeButton) return setTimeout(waitForDetail, 20)
        activeButton.click()
        const waitForDraft = () => {
          if (activeButton.getAttribute('aria-pressed') !== 'true') return setTimeout(waitForDraft, 20)
          if (!row.classList.contains('is-completed')) return resolve(false)
          document.querySelector('.modal-footer .primary-button')?.click()
          const waitForActive = () => {
            if (document.querySelector('.task-modal') || row.classList.contains('is-completed')) {
              return setTimeout(waitForActive, 20)
            }
            resolve(true)
          }
          waitForActive()
        }
        waitForDraft()
      }
      waitForDetail()
    })
  `)
  if (!detailReactivated) throw new Error('Detail status draft was not applied only after saving')

  const detailDeleteConfirmed = await mainWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const row = window.__daylineQaRestoredRow
      const rowCount = document.querySelectorAll('.task-row').length
      row?.querySelector('.task-row-main')?.click()

      const waitForDetail = () => {
        const removeButton = document.querySelector('.task-remove-button')
        if (!removeButton) return setTimeout(waitForDetail, 20)
        removeButton.click()

        const waitForFirstWarning = () => {
          const dialog = document.querySelector('.delete-confirm-dialog')
          if (!dialog) return setTimeout(waitForFirstWarning, 20)
          if (!row.isConnected || document.querySelectorAll('.task-row').length !== rowCount) return resolve(false)
          dialog.querySelector('.secondary-button')?.click()

          const waitForWarningCancel = () => {
            if (document.querySelector('.delete-confirm-dialog')) return setTimeout(waitForWarningCancel, 20)
            if (!document.querySelector('.task-modal') || !row.isConnected) return resolve(false)
            document.querySelector('.task-remove-button')?.click()

            const waitForSecondWarning = () => {
              const confirmButton = document.querySelector('.delete-confirm-button')
              if (!confirmButton) return setTimeout(waitForSecondWarning, 20)
              confirmButton.click()
              const waitForRemoval = () => {
                if (document.querySelector('.task-modal')) return setTimeout(waitForRemoval, 20)
                resolve(document.querySelectorAll('.task-row').length < rowCount)
              }
              waitForRemoval()
            }
            waitForSecondWarning()
          }
          waitForWarningCancel()
        }
        waitForFirstWarning()
      }
      waitForDetail()
    })
  `)
  if (!detailDeleteConfirmed) throw new Error('Detail delete confirmation did not guard and complete deletion')

  await widgetWindow.webContents.executeJavaScript(`
    document.querySelector('.task-row-main')?.click()
  `)
  const widgetDetailReady = await widgetWindow.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const waitForDetail = () => {
        if (document.querySelector('.task-modal') && document.querySelector('.task-state-controls')) resolve(true)
        else setTimeout(waitForDetail, 20)
      }
      waitForDetail()
    })
  `)
  if (!widgetDetailReady) throw new Error('Widget task detail did not expose state controls')

  mainWindow.destroy()
  widgetWindow.destroy()
  clearTimeout(qaTimeout)
  app.quit()
}).catch((error) => {
  clearTimeout(qaTimeout)
  console.error(error)
  app.exit(1)
})
