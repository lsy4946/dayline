const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const statePath = path.resolve(__dirname, '..', 'qa', 'local-update', 'server-state.json')
if (!fs.existsSync(statePath)) {
  process.stdout.write('No managed Dayline local update server state was found.\n')
  process.exit(0)
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const shutdownUrl = new URL('/__shutdown', state.feedUrl)
shutdownUrl.searchParams.set('token', state.shutdownToken)

const request = http.request(shutdownUrl, { method: 'POST', timeout: 2_000 }, (response) => {
  response.resume()
  response.on('end', () => {
    if (response.statusCode !== 200) {
      process.stderr.write(`Local update server refused shutdown (${response.statusCode}).\n`)
      process.exitCode = 1
      return
    }
    fs.unlinkSync(statePath)
    process.stdout.write('Dayline local update server stopped.\n')
  })
})
request.on('timeout', () => request.destroy(new Error('Shutdown request timed out')))
request.on('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
request.end()
