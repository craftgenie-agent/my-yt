import { test, describe, afterEach } from 'node:test'
import assert from 'assert'
import fs from 'fs'
import { getVideosFor, getChannelVideos, setYoutubeDeps, resetYoutubeDeps } from '../lib/youtube.js'
import { ScraperError } from '../lib/scraper-errors.js'

const UCID = 'UCcefcZRL2oaA_uBNeo5UOWg'
const DAY = 24 * 60 * 60
const now = Math.floor(Date.now() / 1000)

function entry (id, extra = {}) {
  return {
    _type: 'url',
    ie_key: 'Youtube',
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Video ${id}`,
    duration: 591,
    view_count: 33000,
    timestamp: now - DAY,
    live_status: null,
    availability: null,
    ...extra
  }
}

// The shape of `yt-dlp --flat-playlist -J` for a channel's /videos tab (2026.10.26).
function playlist (entries) {
  return JSON.stringify({
    _type: 'playlist',
    id: UCID,
    title: 'Y Combinator - Videos',
    channel: 'Y Combinator',
    channel_id: UCID,
    uploader_id: '@ycombinator',
    entries
  })
}

function rss (items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Y Combinator</title>
${items.map(i => ` <entry>
  <yt:videoId>${i.id}</yt:videoId>
  <published>${i.published}</published>
  <media:group><media:description>${i.description || ''}</media:description></media:group>
 </entry>`).join('\n')}
</feed>`
}

function fetchFor (routes) {
  const urls = []
  const fn = async (url) => {
    url = String(url)
    urls.push(url)
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return { ok: true, status: 200, text: async () => body }
    }
    return { ok: false, status: 404, text: async () => 'Not Found' }
  }
  fn.urls = urls
  return fn
}

describe('getVideosFor with yt-dlp', () => {
  afterEach(() => resetYoutubeDeps())

  test('lists the /videos tab of a handle with approximate dates', async () => {
    const calls = []
    setYoutubeDeps({
      runYtDlp: async (args) => { calls.push(args); return playlist([entry('aaaaaaaaaaa')]) },
      fetch: fetchFor({})
    })
    await getVideosFor('ycombinator')
    const args = calls[0]
    assert.ok(args.includes('--flat-playlist'))
    assert.ok(args.includes('-J'))
    assert.ok(args.includes('youtubetab:approximate_date'))
    assert.strictEqual(args[args.length - 1], 'https://www.youtube.com/@ycombinator/videos')
    assert.strictEqual(args[args.length - 2], '--')
  })

  test('a channel id name uses the /channel/ url', async () => {
    const calls = []
    setYoutubeDeps({ runYtDlp: async (args) => { calls.push(args); return playlist([]) }, fetch: fetchFor({}) })
    await getVideosFor(UCID)
    assert.strictEqual(calls[0][calls[0].length - 1], `https://www.youtube.com/channel/${UCID}/videos`)
  })

  test('maps entries to the video objects the app uses', async () => {
    setYoutubeDeps({
      runYtDlp: async () => playlist([entry('u-8KpXcPYCw', { title: '10 Habits', duration: 3725, view_count: 33000 })]),
      fetch: fetchFor({})
    })
    const [video] = await getVideosFor('ycombinator')
    assert.strictEqual(video.id, 'u-8KpXcPYCw')
    assert.strictEqual(video.channelName, 'ycombinator')
    assert.strictEqual(video.title, '10 Habits')
    assert.strictEqual(video.url, 'https://www.youtube.com/watch?v=u-8KpXcPYCw')
    assert.strictEqual(video.thumbnail, 'https://img.youtube.com/vi/u-8KpXcPYCw/mq2.jpg')
    assert.strictEqual(video.duration, '1:02:05')
    assert.strictEqual(video.viewCount, 33000)
    assert.strictEqual(video.description, 'No description')
    assert.ok(video.publishedAt instanceof Date)
    assert.strictEqual(+video.publishedAt, (now - DAY) * 1000)
    assert.match(video.publishedTime, /^\d{4}-\d{2}-\d{2}$/)
    assert.strictEqual(video.isMembersOnly, false)
  })

  test('short durations look like m:ss', async () => {
    setYoutubeDeps({ runYtDlp: async () => playlist([entry('aaaaaaaaaaa', { duration: 591 })]), fetch: fetchFor({}) })
    const [video] = await getVideosFor('ycombinator')
    assert.strictEqual(video.duration, '9:51')
  })

  test('the RSS feed gives exact dates and descriptions when it has the video', async () => {
    const fetch = fetchFor({
      [`https://www.youtube.com/feeds/videos.xml?channel_id=${UCID}`]: rss([
        { id: 'aaaaaaaaaaa', published: '2026-11-04T15:00:23+00:00', description: 'Founders &amp; PhDs' }
      ])
    })
    setYoutubeDeps({
      runYtDlp: async () => playlist([entry('aaaaaaaaaaa', { timestamp: now - 2 * DAY }), entry('bbbbbbbbbbb')]),
      fetch
    })
    const videos = await getVideosFor('ycombinator')
    const a = videos.find(v => v.id === 'aaaaaaaaaaa')
    const b = videos.find(v => v.id === 'bbbbbbbbbbb')
    assert.strictEqual(a.publishedAt.toISOString(), '2026-11-04T15:00:23.000Z')
    assert.strictEqual(a.publishedTime, '2026-11-04')
    assert.strictEqual(a.description, 'Founders & PhDs')
    assert.strictEqual(+b.publishedAt, (now - DAY) * 1000)
  })

  test('a broken RSS feed does not stop the list', async () => {
    setYoutubeDeps({
      runYtDlp: async () => playlist([entry('aaaaaaaaaaa')]),
      fetch: async () => { throw new Error('network down') }
    })
    const videos = await getVideosFor('ycombinator')
    assert.strictEqual(videos.length, 1)
  })

  test('skips live, upcoming, Shorts and members-only videos, as before', async () => {
    setYoutubeDeps({
      runYtDlp: async () => playlist([
        entry('normal00000'),
        entry('wasLive0000', { live_status: 'was_live' }),
        entry('isLive00000', { live_status: 'is_live', duration: null, timestamp: null }),
        entry('upcoming000', { live_status: 'is_upcoming', duration: null, timestamp: null }),
        entry('short000000', { url: 'https://www.youtube.com/shorts/short000000' }),
        entry('members0000', { availability: 'subscriber_only' }),
        entry('noDate00000', { timestamp: null })
      ]),
      fetch: fetchFor({})
    })
    const ids = (await getVideosFor('ycombinator')).map(v => v.id)
    assert.deepStrictEqual(ids, ['normal00000', 'wasLive0000'])

    const withMembers = await getVideosFor('ycombinator', { includeMembersOnly: true })
    const members = withMembers.find(v => v.id === 'members0000')
    assert.ok(members)
    assert.strictEqual(members.isMembersOnly, true)
  })

  test('keeps only the last 6 months', async () => {
    setYoutubeDeps({
      runYtDlp: async () => playlist([entry('new00000000'), entry('old00000000', { timestamp: now - 200 * DAY })]),
      fetch: fetchFor({})
    })
    const ids = (await getVideosFor('ycombinator')).map(v => v.id)
    assert.deepStrictEqual(ids, ['new00000000'])
  })

  test('getChannelVideos also returns the channel name and id', async () => {
    setYoutubeDeps({ runYtDlp: async () => playlist([entry('aaaaaaaaaaa')]), fetch: fetchFor({}) })
    const { channel, videos } = await getChannelVideos('ycombinator')
    assert.deepStrictEqual(channel, { name: 'ycombinator', displayName: 'Y Combinator', channelId: UCID })
    assert.strictEqual(videos.length, 1)
  })

  test('when yt-dlp fails it falls back to the channel page', async () => {
    const html = fs.readFileSync(new URL('./fixtures/channel-page-2026.html', import.meta.url), 'utf8')
    setYoutubeDeps({
      runYtDlp: async () => { throw new Error('spawn yt-dlp ENOENT') },
      fetch: fetchFor({ 'https://www.youtube.com/@ycombinator/videos': html })
    })
    const videos = await getVideosFor('ycombinator')
    assert.strictEqual(videos.length, 2)
  })
})

describe('channel page parser (fallback), YouTube 2026 layout', () => {
  afterEach(() => resetYoutubeDeps())

  async function parseFixture (mutate = (html) => html) {
    const html = mutate(fs.readFileSync(new URL('./fixtures/channel-page-2026.html', import.meta.url), 'utf8'))
    setYoutubeDeps({
      runYtDlp: async () => { throw new Error('no yt-dlp') },
      fetch: fetchFor({ 'https://www.youtube.com/': html })
    })
    return getVideosFor('ycombinator')
  }

  test('reads "33K" and "1d ago" (short units)', async () => {
    const [video] = await parseFixture()
    assert.strictEqual(video.id, 'u-8KpXcPYCw')
    assert.strictEqual(video.title, '10 Habits PhDs Must Unlearn To Build a Startup | Startup School')
    assert.strictEqual(video.viewCount, '33K')
    assert.strictEqual(video.duration, '9:51')
    assert.ok(video.publishedAt instanceof Date)
    const ageDays = (Date.now() - video.publishedAt) / (DAY * 1000)
    assert.ok(ageDays > 0.9 && ageDays < 1.1, `age ${ageDays}`)
  })

  test('reads the short forms without an accessibility label', async () => {
    for (const [text, days] of [['3w ago', 21], ['2mo ago', 61], ['5h ago', 5 / 24]]) {
      const [video] = await parseFixture(html => html.replace('"accessibilityLabel": "1 day ago"', '"x": 1').replace('"1d ago"', JSON.stringify(text)))
      const ageDays = (Date.now() - video.publishedAt) / (DAY * 1000)
      assert.ok(Math.abs(ageDays - days) < 3, `${text}: age ${ageDays}`)
    }
  })

  test('skips members-only videos (2026 badge)', async () => {
    const badge = '"badges": [{"badgeViewModel": {"badgeText": "Members only", "badgeStyle": "BADGE_MEMBERS_ONLY"}}], "metadataParts": ['
    const videos = await parseFixture(html => html.replace('"metadataParts": [', badge))
    assert.deepStrictEqual(videos.map(v => v.id), ['NVzgt2AEvDg'])
  })

  test('no network is a ScraperError too, so one channel does not stop the rest', async () => {
    setYoutubeDeps({ runYtDlp: async () => { throw new Error('no yt-dlp') }, fetch: async () => { throw new TypeError('fetch failed') } })
    await assert.rejects(getVideosFor('ycombinator'), (err) => err instanceof ScraperError && /fetch failed/.test(err.message))
  })

  test('a 404 page is still a ScraperError with the status', async () => {
    setYoutubeDeps({ runYtDlp: async () => { throw new Error('no yt-dlp') }, fetch: fetchFor({}) })
    await assert.rejects(getVideosFor('nope'), (err) => err instanceof ScraperError && err.context.statusCode === 404)
  })
})
