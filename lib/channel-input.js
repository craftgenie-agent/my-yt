// Turns whatever the user pastes (a handle, a channel link, a video link) into one channel.
import { youtubeDeps, parseYtDlpJson, channelInfoFrom, channelUrl, isChannelId } from './youtube.js'

export class ChannelInputError extends Error {
  constructor (message, status = 400) {
    super(message)
    this.name = 'ChannelInputError'
    this.status = status
  }
}

export const MESSAGES = {
  notALink: 'That is not a YouTube channel or video link. Paste a link like https://www.youtube.com/@name or a video link.',
  notFound: 'Could not find that channel on YouTube. Check the link and try again.',
  videoNotFound: 'Could not find the channel of that video. Check the link and try again.'
}

const HANDLE_RE = /^[\p{L}\p{N}._-]{1,100}$/u
const VIDEO_ID_RE = /^[\w-]{11}$/
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
// First path parts that are YouTube pages, not channel names.
const RESERVED = new Set(['watch', 'shorts', 'live', 'embed', 'v', 'playlist', 'feed', 'results', 'channel', 'c', 'user', 'redirect', 'hashtag', 'post', 'account', 'premium', 'gaming', 'music', 'about', 't', 'signin', 'logout', 'oembed', 'feeds', 'attribution_link'])

// One of:
//   { kind: 'handle', value: 'ycombinator' }
//   { kind: 'channel', value: 'UC...' }
//   { kind: 'custom', value: 'https://www.youtube.com/c/Name' }  (/c/, /user/, old custom links)
//   { kind: 'video', value: '<11 char id>' }
// or null when it is not a YouTube channel or video.
export function parseChannelInput (input) {
  let text = String(input ?? '').trim()
  // "@https://..." is what the old app stored for a pasted link.
  text = text.replace(/^@+(?=(https?:\/\/|(www\.|m\.)?youtu))/i, '')
  if (!text) return null

  if (isChannelId(text)) return { kind: 'channel', value: text }
  // A link has a slash, a scheme or a YouTube host. Anything else is a handle, dots allowed.
  const looksLikeLink = /[/:]/.test(text) || /^(www\.|m\.)?(youtube\.com|youtu\.be)$/i.test(text)
  if (!looksLikeLink) {
    const handle = text.replace(/^@/, '')
    return HANDLE_RE.test(handle) ? { kind: 'handle', value: handle } : null
  }

  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  let parts
  try {
    parts = url.pathname.split('/').filter(Boolean).map(p => decodeURIComponent(p))
  } catch {
    return null // a broken % escape
  }

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = parts[0] === 'watch' ? url.searchParams.get('v') : parts[0]
    return VIDEO_ID_RE.test(id || '') ? { kind: 'video', value: id } : null
  }
  if (!YOUTUBE_HOSTS.has(host) || parts.length === 0) return null

  const [first, second] = parts
  if (first.startsWith('@')) {
    const handle = first.slice(1)
    return HANDLE_RE.test(handle) ? { kind: 'handle', value: handle } : null
  }
  if (first === 'watch') {
    const id = url.searchParams.get('v')
    return VIDEO_ID_RE.test(id || '') ? { kind: 'video', value: id } : null
  }
  if (['shorts', 'live', 'embed', 'v'].includes(first)) {
    return VIDEO_ID_RE.test(second || '') ? { kind: 'video', value: second } : null
  }
  if (first === 'channel') {
    return isChannelId(second || '') ? { kind: 'channel', value: second } : null
  }
  if (first === 'c' || first === 'user') {
    return second && HANDLE_RE.test(second) ? { kind: 'custom', value: `https://www.youtube.com/${first}/${encodeURIComponent(second)}` } : null
  }
  if (!RESERVED.has(first) && HANDLE_RE.test(first)) {
    return { kind: 'custom', value: `https://www.youtube.com/${encodeURIComponent(first)}` }
  }
  return null
}

// The stored name, when it can be known without asking YouTube: a handle or a channel id.
export function canonicalChannelName (input) {
  const parsed = parseChannelInput(input)
  if (parsed && (parsed.kind === 'handle' || parsed.kind === 'channel')) return parsed.value
  return null
}

// Asks YouTube which channel the input means.
// Returns { name, displayName, channelId }. name is the handle without @, or the channel id.
export async function resolveChannel (input) {
  const parsed = parseChannelInput(input)
  if (!parsed) throw new ChannelInputError(MESSAGES.notALink, 400)

  if (parsed.kind === 'video') {
    const base = await channelUrlOfVideo(parsed.value)
    return channelFromUrl(base, MESSAGES.videoNotFound)
  }
  const base = parsed.kind === 'custom' ? parsed.value : channelUrl(parsed.value)
  return channelFromUrl(base, MESSAGES.notFound)
}

async function channelFromUrl (base, notFoundMessage) {
  let json
  try {
    json = parseYtDlpJson(await youtubeDeps.runYtDlp([
      '--flat-playlist', '-J', '--playlist-end', '1', '--', `${base}/videos`
    ]))
  } catch (error) {
    console.error(`[channels] yt-dlp could not read ${base}: ${lastLine(error)}`)
    throw new ChannelInputError(notFoundMessage, 404)
  }
  const channel = channelInfoFrom(json)
  if (!channel.name) throw new ChannelInputError(notFoundMessage, 404)
  return { name: channel.name, displayName: channel.displayName || channel.name, ...(channel.channelId ? { channelId: channel.channelId } : {}) }
}

// The channel link of a video: oEmbed first (fast, no yt-dlp), then yt-dlp.
async function channelUrlOfVideo (videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`
  try {
    const response = await youtubeDeps.fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`)
    if (response.ok) {
      const data = await response.json()
      const parsed = parseChannelInput(data.author_url)
      if (parsed && parsed.kind !== 'video') return parsed.kind === 'custom' ? parsed.value : channelUrl(parsed.value)
    }
  } catch (error) {
    console.error(`[channels] oEmbed failed for ${videoId}: ${lastLine(error)}`)
  }
  try {
    const json = parseYtDlpJson(await youtubeDeps.runYtDlp(['-J', '--skip-download', '--no-playlist', '--', videoId]))
    const { name } = channelInfoFrom(json)
    if (name) return channelUrl(name)
  } catch (error) {
    console.error(`[channels] yt-dlp could not read video ${videoId}: ${lastLine(error)}`)
  }
  throw new ChannelInputError(MESSAGES.videoNotFound, 404)
}

function lastLine (error) {
  return String(error?.stderr || error?.message || error).trim().split('\n').filter(Boolean).pop()
}
