const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') {
  throw new Error('The Dayline update helper can only be built on Windows')
}

const projectDir = path.resolve(__dirname, '..')
const sourcePath = path.join(projectDir, 'build', 'update-helper', 'Program.cs')
const outputPath = path.join(projectDir, 'build', 'update-helper.exe')
const iconPath = path.join(projectDir, 'build', 'icon.ico')
const frameworkRoot = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET')
const compilerCandidates = [
  path.join(frameworkRoot, 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(frameworkRoot, 'Framework', 'v4.0.30319', 'csc.exe'),
]
const compilerPath = compilerCandidates.find((candidate) => fs.existsSync(candidate))

if (!compilerPath) throw new Error('Microsoft .NET Framework C# compiler was not found')

const result = spawnSync(compilerPath, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  `/win32icon:${iconPath}`,
  '/reference:System.dll',
  '/reference:System.Core.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll',
  `/out:${outputPath}`,
  sourcePath,
], {
  cwd: projectDir,
  encoding: 'utf8',
  windowsHide: true,
})

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) process.exit(result.status || 1)

const stats = fs.statSync(outputPath)
process.stdout.write(`Built ${path.relative(projectDir, outputPath)} (${stats.size} bytes)\n`)
