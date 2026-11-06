import spawn from 'nano-spawn'
import fs from 'fs'
import * as ytdlp from './yt-dlp.js'
import { runWorkerDownload, runWorkerTranscode } from './workers/run-worker.js'
import { getRepository } from '../server/service-container.js'
import { ScraperError } from './scraper-errors.js'

export const ytUrlRegExp = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/(?:watch\?v=)?)([\w-]+)/

const fetchYoutubeHeaders = {
  'Accept-Language': 'en',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
}

function parseDuration (durationStr) {
  if (!durationStr) return null
  const parts = durationStr.split(':').map(Number)
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  return null
}

export async function downloadVideo (id, callback = () => {}) {
  const repo = getRepository()
  if (isUnsupportedUrl(id)) throw new Error('unsupported url')

  const videoId = isYouTubeUrl(id) ? extractIdFromUrl(id) : id
  if (!repo.getVideo(videoId)) {
    repo.upsertVideos([await getVideo(videoId)])
  }

  const quality = repo.getVideoQualitySetting()
  console.log('Video processing completed', await runWorkerDownload(videoId, quality, (message) => {
    callback(message)
  }))

  const video = repo.updateVideo(videoId, { location: null, format: null })
  if (repo.getTranscodeVideosSetting() && video.location && video.format) {
    await runWorkerTranscode(video.location, video.format, parseDuration(video.duration), (message) => {
      callback(message)
    })

    const tmpLocation = video.location.replace(video.format, 'tmp.' + video.format)
    fs.renameSync(tmpLocation, video.location)

    console.log(`successfully transcoded video ${video.location}`)
  }

  repo.updateVideo(videoId, { downloaded: true })
  normalizeSubtitleFiles(videoId)

  return videoId
}

export async function getVideoSubtitles (id, callback = () => {}) {
  const transcriptPath = `./data/videos/${id}.en.srt`
  if (!fs.existsSync(transcriptPath)) {
    for await (const line of ytdlp.subtitles(id)) {
      console.log(line)
      callback(line)
    }
  }

  normalizeSubtitleFiles(id)

  try {
    const transcript = fs.readFileSync(transcriptPath, 'utf-8')
    return transcript
  } catch (error) {
    console.error('Error downloading video subtitles:', error.message)
    throw error
  }
}

function normalizeSubtitleFiles (id) {
  const files = fs.readdirSync('./data/videos')
  files.forEach(file => {
    if (file.startsWith(id) && file.endsWith('.srt')) {
      if (!file.endsWith('.en.srt')) {
        fs.renameSync(`./data/videos/${file}`, `./data/videos/${id}.en.srt`)
      }
    }
    if (file.startsWith(id) && file.endsWith('.vtt')) {
      if (!file.endsWith('.en.vtt')) {
        fs.renameSync(`./data/videos/${file}`, `./data/videos/${id}.en.vtt`)
      }
    }
  })
}
// yt-dlp and fetch, swappable in tests.
const defaultDeps = {
  runYtDlp: (args) => ytdlp.run(args),
  fetch: (...args) => globalThis.fetch(...args)
}
export const youtubeDeps = { ...defaultDeps }
export function setYoutubeDeps (overrides = {}) { Object.assign(youtubeDeps, overrides) }
export function resetYoutubeDeps () { Object.assign(youtubeDeps, defaultDeps) }

const CHANNEL_ID_RE = /^UC[\w-]{22}$/
const SIX_MONTHS_MS = 6 * 31 * 24 * 60 * 60 * 1000
const CHANNEL_VIDEOS_LIMIT = 30

export function isChannelId (name = '') {
  return CHANNEL_ID_RE.test(name)
}

// The base URL of a stored channel name: a handle (without @) or a UC... channel id.
export function channelUrl (name = '') {
  if (isChannelId(name)) return `https://www.youtube.com/channel/${name}`
  return `https://www.youtube.com/${name.startsWith('@') ? name : '@' + name}`
}

// Parses `yt-dlp -J` output. yt-dlp prints one JSON line; skip anything else.
export function parseYtDlpJson (output = '') {
  const line = String(output).split('\n').find(l => l.trim().startsWith('{'))
  if (!line) throw new Error('yt-dlp printed no JSON')
  return JSON.parse(line)
}

// The channel facts yt-dlp gives for a channel tab or a video.
export function channelInfoFrom (json = {}, fallbackName) {
  const handle = typeof json.uploader_id === 'string' && json.uploader_id.startsWith('@') ? json.uploader_id.slice(1) : null
  const channelId = isChannelId(json.channel_id) ? json.channel_id : null
  const channel = { name: handle || channelId || fallbackName }
  const displayName = json.channel || json.uploader
  if (displayName) channel.displayName = displayName
  if (channelId) channel.channelId = channelId
  return channel
}

export async function getVideosFor (channelName, options = {}) {
  const { videos } = await getChannelVideos(channelName, options)
  return videos
}

// The latest videos of a channel, and the channel's name and id.
// yt-dlp first (it follows YouTube's changes), the channel page as a fallback.
export async function getChannelVideos (channelName, { includeMembersOnly = false } = {}) {
  let result
  try {
    result = await getChannelVideosWithYtDlp(channelName)
  } catch (error) {
    console.error(`[yt-dlp] Could not list videos for ${channelName}, trying the channel page: ${firstLine(error)}`)
    result = { channel: { name: channelName }, videos: await scrapeChannelPage(channelName) }
  }
  const minDate = new Date(Date.now() - SIX_MONTHS_MS)
  const videos = result.videos
    .filter(v => includeMembersOnly || !v.isMembersOnly)
    .filter(v => v.publishedAt > minDate)
  return { channel: result.channel, videos }
}

async function getChannelVideosWithYtDlp (channelName) {
  const output = await youtubeDeps.runYtDlp([
    '--flat-playlist',
    '-J',
    '--playlist-end', String(CHANNEL_VIDEOS_LIMIT),
    // Dates from "1d ago". Not exact, the RSS feed below fixes the newest ones.
    '--extractor-args', 'youtubetab:approximate_date',
    '--',
    `${channelUrl(channelName)}/videos`
  ])
  const json = parseYtDlpJson(output)
  const channel = channelInfoFrom(json, channelName)
  const feed = channel.channelId ? await getFeedEntries(channel.channelId) : new Map()
  const videos = (json.entries || [])
    .filter(e => e && e.id)
    // Not watchable yet: live now or a premiere. The old parser skipped these too.
    .filter(e => e.live_status !== 'is_live' && e.live_status !== 'is_upcoming')
    .filter(e => !/\/shorts\//.test(e.url || ''))
    .map(e => ytDlpEntryToVideo(e, channelName, feed.get(e.id)))
  return { channel, videos }
}

function ytDlpEntryToVideo (entry, channelName, feedEntry) {
  const id = entry.id
  const publishedAt = feedEntry?.published || (entry.timestamp ? new Date(entry.timestamp * 1000) : null)
  return {
    channelName,
    title: entry.title || 'Unparsable title',
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: `https://img.youtube.com/vi/${id}/mq2.jpg`,
    description: feedEntry?.description || 'No description',
    id,
    viewCount: entry.view_count ?? 'Unknown views',
    publishedTime: publishedAt ? publishedAt.toISOString().substring(0, 10) : 'Unknown time',
    publishedAt,
    duration: formatDuration(entry.duration) || 'Unknown duration',
    isMembersOnly: entry.availability === 'subscriber_only'
  }
}

export function formatDuration (seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return null
  seconds = Math.round(seconds)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// The channel's RSS feed: exact dates and descriptions of its last 15 uploads.
// Best effort: a failure only means approximate dates.
async function getFeedEntries (channelId) {
  const entries = new Map()
  try {
    const response = await youtubeDeps.fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: fetchYoutubeHeaders })
    if (!response.ok) return entries
    const xml = await response.text()
    for (const [, body] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const id = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]
      const published = new Date(body.match(/<published>([^<]+)<\/published>/)?.[1])
      const description = decodeXml(body.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || '').trim()
      if (id && !isNaN(published)) entries.set(id, { published, description })
    }
  } catch (error) {
    console.error(`[rss] Could not read the feed of ${channelId}: ${firstLine(error)}`)
  }
  return entries
}

function decodeXml (text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&')
}

function firstLine (error) {
  return String(error?.stderr || error?.message || error).trim().split('\n').filter(Boolean).pop()
}

// Fallback: read the videos from the channel page's ytInitialData.
async function scrapeChannelPage (channelName) {
  const pageUrl = `${channelUrl(channelName)}/videos`
  let response
  try {
    response = await youtubeDeps.fetch(pageUrl, { headers: fetchYoutubeHeaders })
  } catch (error) {
    throw new ScraperError(`Could not fetch the channel page for @${channelName}: ${error.message}`, { channel: channelName })
  }

  if (!response.ok) {
    throw new ScraperError(`HTTP ${response.status} fetching channel page for @${channelName}`, {
      statusCode: response.status,
      channel: channelName
    })
  }

  const text = await response.text()
  const match = text.match(/var ytInitialData = (.+?);<\/script>/)

  if (!match || !match[1]) {
    console.error(`[scraper] No ytInitialData found for @${channelName}`)
    console.error(`[scraper] Last 200 chars of response: "${text.slice(-200)}"`)
    throw new ScraperError('YouTube HTML structure changed — scraper regex no longer matches', {
      channel: channelName
    })
  }

  try {
    const json = JSON.parse(match[1].trim())
    const videoTab = json.contents.twoColumnBrowseResultsRenderer.tabs.find(t => t.tabRenderer?.title === 'Videos')
    if (!videoTab || !videoTab.tabRenderer) {
      throw new ScraperError('YouTube channel page has no "Videos" tab — structure may have changed', {
        channel: channelName
      })
    }
    const videoContents = videoTab.tabRenderer.content.richGridRenderer.contents
    return videoContents
      .map(toInternalVideo)
      .filter(Boolean)
  } catch (error) {
    if (error instanceof ScraperError) throw error
    // Unexpected parse errors — wrap as scraper failure
    console.error(`[scraper] Failed to parse channel data for @${channelName}: ${error.message}`)
    throw new ScraperError('Failed to parse YouTube channel data', {
      channel: channelName
    })
  }

  function toInternalVideo (v) {
    if (!v || !v.richItemRenderer) return
    const data = v.richItemRenderer.content.lockupViewModel
    if (!data) return

    const rows = data.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || []
    const isMembersOnly = !!(data.badges?.some(badge =>
      badge.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_MEMBERS_ONLY'
    ) || rows.some(row => row.badges?.some(badge =>
      badge.badgeViewModel?.badgeStyle === 'BADGE_MEMBERS_ONLY'
    )))

    const metadataParts = rows.find(row => row.metadataParts?.length)?.metadataParts || []
    // The long form ("1 day ago") is in the accessibility label, the text is short ("1d ago").
    const parts = metadataParts.map(p => ({ text: p.text?.content, label: p.accessibilityLabel }))
    const timePart = parts.find(p => isRelativeTimeString(p.label) || isRelativeTimeString(p.text))
    const viewsPart = parts.find(p => p !== timePart)
    const publishedTime = timePart && (isRelativeTimeString(timePart.label) ? timePart.label : timePart.text)

    const badge = data.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel
    const duration = /^\d+(:\d+)+$/.test(badge?.text || '') ? badge.text : badge?.rendererContext?.accessibilityContext?.label

    return {
      channelName,
      title: data.metadata?.lockupMetadataViewModel?.title?.content || 'Unparsable title',
      url: `https://www.youtube.com/watch?v=${data.contentId}`,
      thumbnail: `https://img.youtube.com/vi/${data.contentId}/mq2.jpg`,
      description: 'No description',
      id: data.contentId,
      viewCount: viewsPart?.text || 'Unparsable views',
      publishedTime: publishedTime || 'Unknown time',
      publishedAt: publishedTime ? parseRelativeTime(publishedTime) : null,
      duration: duration || 'Unknown duration',
      isMembersOnly
    }
  }
}

export async function getVideo (id) {
  if (isUnsupportedUrl(id)) return null
  if (isYouTubeUrl(id)) id = extractIdFromUrl(id)
  try {
    let { output } = await spawn('yt-dlp', ['-j', '--', id])
    output = output.split('\n').filter(l => l.startsWith('{'))
    const json = JSON.parse(output)
    return {
      channelName: json.uploader_id.replace(/^@/, ''),
      title: json.title,
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: `https://img.youtube.com/vi/${id}/mq2.jpg`,
      description: json.description,
      id,
      publishedTime: json.upload_date.substring(0, 4) + '-' + json.upload_date.substring(4, 6) + '-' + json.upload_date.substring(6, 8),
      publishedAt: new Date(json.timestamp * 1000),
      viewCount: json.view_count,
      duration: json.duration_string
    }
  } catch (err) {
    console.error(err)
    return null
  }
}

// "3 days ago", and since 2026 also the short "3d ago", "2mo ago", "5h ago".
const RELATIVE_TIME_RE = /(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?|mo|s|m|h|d|w|y)\s+ago/i

function isRelativeTimeString (str) {
  return typeof str === 'string' && RELATIVE_TIME_RE.test(str)
}

function parseRelativeTime (relativeTime) {
  const match = typeof relativeTime === 'string' && relativeTime.match(RELATIVE_TIME_RE)
  if (!match) {
    console.error('Invalid relative time format', relativeTime)
    return null
  }
  const amount = parseInt(match[1], 10)
  const unit = match[2].toLowerCase()
  const now = new Date()
  if (unit === 'mo' || unit.startsWith('month')) now.setMonth(now.getMonth() - amount)
  else if (unit.startsWith('s')) now.setSeconds(now.getSeconds() - amount)
  else if (unit.startsWith('m')) now.setMinutes(now.getMinutes() - amount)
  else if (unit.startsWith('h')) now.setHours(now.getHours() - amount)
  else if (unit.startsWith('d')) now.setDate(now.getDate() - amount)
  else if (unit.startsWith('w')) now.setDate(now.getDate() - amount * 7)
  else if (unit.startsWith('y')) now.setFullYear(now.getFullYear() - amount)
  return now
}

export function extractIdFromUrl (url) {
  if (isYouTubeUrl(url)) {
    const match = url.match(ytUrlRegExp)
    return match ? match[1] : null // Extract the first capture group
  }
}

export function isYouTubeUrl (url) {
  return ytUrlRegExp.test(url)
}

export function isUnsupportedUrl (url) {
  return !isYouTubeUrl(url) && !isVideoId(url)
}

export function isVideoId (url) {
  return !/^https?/.test(url)
}
