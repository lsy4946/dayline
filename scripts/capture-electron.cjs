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

app.whenReady().then(async () => {
  const outputDir = path.join(__dirname, '..', 'qa')
  fs.mkdirSync(outputDir, { recursive: true })
  const rendererPath = path.join(__dirname, '..', 'dist', 'index.html')

  const mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    backgroundColor: '#f4f5f0',
  })
  const widgetWindow = new BrowserWindow({
    width: 390,
    height: 620,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
  })

  const mainLoaded = waitForLoad(mainWindow)
  const widgetLoaded = waitForLoad(widgetWindow)
  await Promise.all([
    mainWindow.loadFile(rendererPath, { query: { mode: 'main' } }),
    widgetWindow.loadFile(rendererPath, { query: { mode: 'widget' } }),
    mainLoaded,
    widgetLoaded,
  ])

  await new Promise((resolve) => setTimeout(resolve, 500))
  const [mainImage, widgetImage] = await Promise.all([
    mainWindow.webContents.capturePage(),
    widgetWindow.webContents.capturePage(),
  ])
  fs.writeFileSync(path.join(outputDir, 'main-window.png'), mainImage.toPNG())
  fs.writeFileSync(path.join(outputDir, 'widget-window.png'), widgetImage.toPNG())

  mainWindow.destroy()
  widgetWindow.destroy()
  app.quit()
})
