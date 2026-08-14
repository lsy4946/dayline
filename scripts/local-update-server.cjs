const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const root = path.resolve(argument('root'))
const port = Number(argument('port', '43127'))
const shutdownToken = argument('shutdown-token')
if (!root || !fs.existsSync(root)) throw new Error('A valid --root update directory is required')
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local update server port')

const contentTypes = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
}

function respondFile(request, response, filePath) {
  const stats = fs.statSync(filePath)
  const contentType = contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  const rangeMatch = /^bytes=(\d+)-(\d*)$/i.exec(request.headers.range || '')
  response.setHeader('Accept-Ranges', 'bytes')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', contentType)

  if (rangeMatch) {
    const start = Number(rangeMatch[1])
    const requestedEnd = rangeMatch[2] ? Number(rangeMatch[2]) : stats.size - 1
    const end = Math.min(requestedEnd, stats.size - 1)
    if (start >= stats.size || end < start) {
      response.writeHead(416, { 'Content-Range': `bytes */${stats.size}` })
      response.end()
      return
    }
    response.writeHead(206, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
    })
    if (request.method === 'HEAD') response.end()
    else fs.createReadStream(filePath, { start, end }).pipe(response)
    return
  }

  response.writeHead(200, { 'Content-Length': stats.size })
  if (request.method === 'HEAD') response.end()
  else fs.createReadStream(filePath).pipe(response)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${port}`}`)
  if (url.pathname === '/__health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ ok: true, root }))
    return
  }
  if (url.pathname === '/__shutdown' && request.method === 'POST') {
    if (!shutdownToken || url.searchParams.get('token') !== shutdownToken) {
      response.writeHead(403)
      response.end('Forbidden')
      return
    }
    response.writeHead(200)
    response.end('Stopping')
    setImmediate(() => server.close(() => process.exit(0)))
    return
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405)
    response.end('Method Not Allowed')
    return
  }

  let relativePath
  try {
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    response.writeHead(400)
    response.end('Bad Request')
    return
  }
  const filePath = path.resolve(root, relativePath)
  const rootPrefix = `${root}${path.sep}`
  if (!filePath.startsWith(rootPrefix) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404)
    response.end('Not Found')
    return
  }
  respondFile(request, response, filePath)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Dayline local update server: http://127.0.0.1:${port}\n`)
  process.stdout.write(`Serving: ${root}\n`)
})

server.on('error', (error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exit(1)
})
