const { randomUUID } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const projectDir = path.resolve(__dirname, '..')
const qaRoot = path.join(projectDir, 'qa', 'local-update')
const manifestPath = path.join(qaRoot, 'manifest.json')
const statePath = path.join(qaRoot, 'server-state.json')
const logPath = path.join(qaRoot, 'server.log')

if (!fs.existsSync(manifestPath)) {
  throw new Error('Local update QA builds are missing. Run npm run qa:update:local:build first.')
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (!fs.existsSync(manifest.clientSetup) || !fs.existsSync(path.join(manifest.serverDirectory, 'latest.yml'))) {
  throw new Error('Local update QA artifacts are incomplete. Rebuild them first.')
}

function healthCheck() {
  return new Promise((resolve) => {
    const request = http.get(`${manifest.feedUrl}/__health`, (response) => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.setTimeout(500, () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

async function waitForServer() {
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    if (await healthCheck()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Local update server did not start. See ${logPath}`)
}

async function main() {
  if (await healthCheck()) {
    process.stdout.write(`A local update server is already running at ${manifest.feedUrl}.\n`)
  } else {
    const shutdownToken = randomUUID()
    const logHandle = fs.openSync(logPath, 'a')
    const server = spawn(process.execPath, [
      path.join(__dirname, 'local-update-server.cjs'),
      '--root', manifest.serverDirectory,
      '--port', String(manifest.port),
      '--shutdown-token', shutdownToken,
    ], {
      cwd: projectDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logHandle, logHandle],
    })
    server.unref()
    fs.closeSync(logHandle)
    fs.writeFileSync(statePath, `${JSON.stringify({
      pid: server.pid,
      shutdownToken,
      feedUrl: manifest.feedUrl,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8')
    await waitForServer()
    process.stdout.write(`Local update server started at ${manifest.feedUrl}.\n`)
  }

  process.stdout.write(`Installing and launching Dayline Update QA v${manifest.clientVersion}...\n`)
  const install = spawnSync(manifest.clientSetup, ['/S', '--force-run', '/currentuser'], {
    cwd: projectDir,
    stdio: 'inherit',
    windowsHide: false,
  })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`QA client installer exited with code ${install.status}`)
  process.stdout.write(`\nReady: open 업데이트 in Dayline Update QA and check for v${manifest.updateVersion}.\n`)
  process.stdout.write('When finished, run npm run qa:update:local:stop.\n')
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exit(1)
})
