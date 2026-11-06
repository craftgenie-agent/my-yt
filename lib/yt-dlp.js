import spawn from 'nano-spawn'
import { subtitlesYTDLPArgs, videoYTDLPArgs, buildCookiesOption } from './yt-dlp-args.js'

export function video (id, quality) {
  const cookiesOption = buildCookiesOption()
  return spawn('yt-dlp', [
    '-o',
    `./data/videos/${id}.%(ext)s`,
    ...cookiesOption,
    ...videoYTDLPArgs(quality),
    // ...subtitlesYTDLPArgs,
    '--',
    id
  ])
}
export function subtitles (id) {
  const cookiesOption = buildCookiesOption()
  return spawn('yt-dlp', [
    '-o',
    `./data/videos/${id}`,
    '--skip-download',
    ...cookiesOption,
    ...subtitlesYTDLPArgs,
    '--',
    id
  ])
}

// Runs yt-dlp and returns its stdout. Used for JSON output (-J), so no progress lines.
export async function run (args, { timeout = 120000 } = {}) {
  const { stdout } = await spawn('yt-dlp', [...buildCookiesOption(), ...args], { timeout })
  return stdout
}
