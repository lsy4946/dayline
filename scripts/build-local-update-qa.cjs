const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectDir = path.resolve(__dirname, '..')
const qaRoot = path.join(projectDir, 'qa', 'local-update')
const clientVersion = '0.4.0'
const updateVersion = '0.4.1'
const port = 43127
const feedUrl = `http://127.0.0.1:${port}`
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
const baseBuild = packageJson.build

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}

function runNpmScript(scriptName) {
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd run ${scriptName}`])
}

function qaConfig(version, outputDirectory) {
  return {
    ...baseBuild,
    appId: 'com.dayline.desktop.updateqa',
    productName: 'Dayline Update QA',
    extraMetadata: {
      name: 'dayline-update-qa',
      productName: 'Dayline Update QA',
      version,
    },
    directories: {
      ...baseBuild.directories,
      output: path.relative(projectDir, outputDirectory).replaceAll('\\', '/'),
    },
    win: {
      ...baseBuild.win,
      target: [{ target: 'nsis', arch: ['x64'] }],
      artifactName: 'Dayline-Update-QA-Setup-${version}-${arch}.${ext}',
    },
    nsis: {
      ...baseBuild.nsis,
      shortcutName: 'Dayline Update QA',
    },
    publish: [{ provider: 'generic', url: feedUrl }],
    releaseInfo: {
      releaseName: `Dayline Update QA v${version}`,
      releaseNotes: version === updateVersion
        ? '## 로컬 업데이트 통합 테스트\n\n- GitHub 업로드 없이 로컬 서버에서 받은 테스트 업데이트입니다.\n- 설치 UI 인계와 자동 재시작을 확인합니다.'
        : '로컬 업데이트 테스트용 시작 버전입니다.',
    },
  }
}

function buildVersion(version, folderName) {
  const outputDirectory = path.join(qaRoot, folderName)
  fs.mkdirSync(outputDirectory, { recursive: true })
  const configPath = path.join(qaRoot, `builder-${version}.json`)
  fs.writeFileSync(configPath, `${JSON.stringify(qaConfig(version, outputDirectory), null, 2)}\n`, 'utf8')
  run(process.execPath, [
    path.join(projectDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    '--win',
    'nsis',
    '--x64',
    '--config',
    configPath,
    '--publish',
    'never',
  ])
  const setupPath = path.join(outputDirectory, `Dayline-Update-QA-Setup-${version}-x64.exe`)
  if (!fs.existsSync(setupPath)) throw new Error(`QA setup was not created: ${setupPath}`)
  return { outputDirectory, setupPath }
}

fs.mkdirSync(qaRoot, { recursive: true })
runNpmScript('build')
runNpmScript('build:update-helper')

process.stdout.write(`\nBuilding local update target v${updateVersion}...\n`)
const update = buildVersion(updateVersion, 'server')
const latestPath = path.join(update.outputDirectory, 'latest.yml')
if (!fs.existsSync(latestPath)) throw new Error('The local update feed did not produce latest.yml')
const latestYaml = fs.readFileSync(latestPath, 'utf8')
if (!new RegExp(`^version:\\s*${updateVersion.replaceAll('.', '\\.')}\\s*$`, 'm').test(latestYaml)) {
  throw new Error(`latest.yml does not advertise v${updateVersion}`)
}

process.stdout.write(`\nBuilding installed test client v${clientVersion}...\n`)
const client = buildVersion(clientVersion, 'client')

const manifest = {
  appId: 'com.dayline.desktop.updateqa',
  productName: 'Dayline Update QA',
  clientVersion,
  updateVersion,
  port,
  feedUrl,
  clientSetup: client.setupPath,
  serverDirectory: update.outputDirectory,
  updateSetup: update.setupPath,
  createdAt: new Date().toISOString(),
}
fs.writeFileSync(path.join(qaRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

process.stdout.write(`\nLocal update QA builds are ready.\n`)
process.stdout.write(`Client: ${client.setupPath}\n`)
process.stdout.write(`Update: ${update.setupPath}\n`)
process.stdout.write(`Feed:   ${feedUrl}\n`)
