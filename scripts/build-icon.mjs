import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.join(scriptDir, '..', 'build')
const svgPath = path.join(buildDir, 'icon.svg')
const pngPath = path.join(buildDir, 'icon.png')
const icoSourcePath = path.join(buildDir, 'icon-256.png')
const icoPath = path.join(buildDir, 'icon.ico')

await sharp(svgPath).resize(512, 512).png().toFile(pngPath)
await sharp(svgPath).resize(256, 256).png().toFile(icoSourcePath)
const ico = await pngToIco(icoSourcePath)
await fs.writeFile(icoPath, ico)

console.log(`Generated ${path.relative(process.cwd(), pngPath)} and ${path.relative(process.cwd(), icoPath)}`)
