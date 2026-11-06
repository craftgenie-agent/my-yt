import { test, describe, afterEach } from 'node:test'
import assert from 'assert'
import { parseChannelInput, canonicalChannelName, resolveChannel, ChannelInputError } from '../lib/channel-input.js'
import { setYoutubeDeps, resetYoutubeDeps } from '../lib/youtube.js'

const UCID = 'UCcefcZRL2oaA_uBNeo5UOWg'

describe('parseChannelInput', () => {
  const handleCases = [
    'ycombinator',
    '@ycombinator',
    ' @ycombinator ',
    'youtube.com/@ycombinator',
    'www.youtube.com/@ycombinator',
    'https://www.youtube.com/@ycombinator',
    'http://youtube.com/@ycombinator',
    'https://m.youtube.com/@ycombinator',
    'https://www.youtube.com/@ycombinator/videos',
    'https://www.youtube.com/@ycombinator/featured',
    'https://www.youtube.com/@ycombinator?si=abc123',
    'https://www.youtube.com/@ycombinator/videos?view=0&sort=dd#x',
    // the bad form the old app stored
    '@https://www.youtube.com/@ycombinator'
  ]
  for (const input of handleCases) {
    test(`handle from ${JSON.stringify(input)}`, () => {
      assert.deepStrictEqual(parseChannelInput(input), { kind: 'handle', value: 'ycombinator' })
    })
  }

  test('handles with dots, dashes and underscores, with or without @', () => {
    assert.deepStrictEqual(parseChannelInput('@Some.Name-1_x'), { kind: 'handle', value: 'Some.Name-1_x' })
    assert.deepStrictEqual(parseChannelInput('Some.Name-1_x'), { kind: 'handle', value: 'Some.Name-1_x' })
  })

  test('a link with a broken % escape is not a channel, and does not throw', () => {
    assert.strictEqual(parseChannelInput('https://youtube.com/@name%'), null)
    assert.strictEqual(parseChannelInput('https://www.youtube.com/c/%E0%A4%A'), null)
    assert.strictEqual(canonicalChannelName('https://youtube.com/@name%'), null)
  })

  test('channel id links and bare ids', () => {
    for (const input of [
      `https://www.youtube.com/channel/${UCID}`,
      `youtube.com/channel/${UCID}/videos`,
      `https://m.youtube.com/channel/${UCID}?app=desktop`,
      UCID
    ]) {
      assert.deepStrictEqual(parseChannelInput(input), { kind: 'channel', value: UCID }, input)
    }
  })

  test('legacy /c/ and /user/ links', () => {
    assert.deepStrictEqual(parseChannelInput('https://www.youtube.com/c/Veritasium/videos'), { kind: 'custom', value: 'https://www.youtube.com/c/Veritasium' })
    assert.deepStrictEqual(parseChannelInput('youtube.com/user/1veritasium'), { kind: 'custom', value: 'https://www.youtube.com/user/1veritasium' })
  })

  test('video links', () => {
    for (const input of [
      'https://www.youtube.com/watch?v=u-8KpXcPYCw',
      'https://www.youtube.com/watch?feature=share&v=u-8KpXcPYCw&t=10s',
      'https://m.youtube.com/watch?v=u-8KpXcPYCw',
      'https://youtu.be/u-8KpXcPYCw?si=xyz',
      'youtu.be/u-8KpXcPYCw',
      'https://www.youtube.com/shorts/u-8KpXcPYCw',
      'https://www.youtube.com/live/u-8KpXcPYCw?feature=shared'
    ]) {
      assert.deepStrictEqual(parseChannelInput(input), { kind: 'video', value: 'u-8KpXcPYCw' }, input)
    }
  })

  test('things that are not a channel', () => {
    for (const input of ['', '   ', 'https://vimeo.com/123', 'https://www.youtube.com/', 'https://www.youtube.com/playlist?list=PL123', 'two words', '@', 'https://www.youtube.com/watch']) {
      assert.strictEqual(parseChannelInput(input), null, input)
    }
  })
})

describe('canonicalChannelName', () => {
  test('works offline for handles and channel ids', () => {
    assert.strictEqual(canonicalChannelName('@https://www.youtube.com/@ycombinator'), 'ycombinator')
    assert.strictEqual(canonicalChannelName('ycombinator'), 'ycombinator')
    assert.strictEqual(canonicalChannelName(`https://youtube.com/channel/${UCID}`), UCID)
  })

  test('is null when it needs YouTube to know', () => {
    assert.strictEqual(canonicalChannelName('https://youtu.be/u-8KpXcPYCw'), null)
    assert.strictEqual(canonicalChannelName('https://www.youtube.com/c/Veritasium'), null)
    assert.strictEqual(canonicalChannelName('not a channel'), null)
  })
})

describe('resolveChannel', () => {
  afterEach(() => resetYoutubeDeps())

  const channelJson = JSON.stringify({
    _type: 'playlist',
    id: UCID,
    channel: 'Y Combinator',
    channel_id: UCID,
    uploader_id: '@ycombinator',
    entries: []
  })

  test('a handle link resolves to the handle, the name and the id', async () => {
    const calls = []
    setYoutubeDeps({ runYtDlp: async (args) => { calls.push(args); return channelJson } })
    const channel = await resolveChannel('https://www.youtube.com/@ycombinator/featured')
    assert.deepStrictEqual(channel, { name: 'ycombinator', displayName: 'Y Combinator', channelId: UCID })
    assert.ok(calls[0].includes('https://www.youtube.com/@ycombinator/videos'), calls[0].join(' '))
  })

  test('a channel id link resolves to the handle when the channel has one', async () => {
    const calls = []
    setYoutubeDeps({ runYtDlp: async (args) => { calls.push(args); return channelJson } })
    const channel = await resolveChannel(`https://www.youtube.com/channel/${UCID}`)
    assert.strictEqual(channel.name, 'ycombinator')
    assert.ok(calls[0].includes(`https://www.youtube.com/channel/${UCID}/videos`))
  })

  test('a channel without a handle is stored by its id', async () => {
    setYoutubeDeps({ runYtDlp: async () => JSON.stringify({ channel: 'Old Channel', channel_id: UCID, uploader_id: null }) })
    const channel = await resolveChannel(UCID)
    assert.deepStrictEqual(channel, { name: UCID, displayName: 'Old Channel', channelId: UCID })
  })

  test('a video link finds its channel with oEmbed', async () => {
    const urls = []
    setYoutubeDeps({
      fetch: async (url) => {
        urls.push(String(url))
        return { ok: true, status: 200, json: async () => ({ author_name: 'Y Combinator', author_url: 'https://www.youtube.com/@ycombinator' }) }
      },
      runYtDlp: async () => channelJson
    })
    const channel = await resolveChannel('https://youtu.be/u-8KpXcPYCw?si=x')
    assert.strictEqual(channel.name, 'ycombinator')
    assert.strictEqual(channel.displayName, 'Y Combinator')
    assert.ok(urls[0].startsWith('https://www.youtube.com/oembed?'), urls[0])
    assert.ok(urls[0].includes(encodeURIComponent('https://www.youtube.com/watch?v=u-8KpXcPYCw')))
  })

  test('a video link falls back to yt-dlp when oEmbed fails', async () => {
    const calls = []
    setYoutubeDeps({
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      runYtDlp: async (args) => {
        calls.push(args)
        if (args.includes('u-8KpXcPYCw')) return JSON.stringify({ id: 'u-8KpXcPYCw', channel_id: UCID, uploader_id: '@ycombinator' })
        return channelJson
      }
    })
    const channel = await resolveChannel('https://www.youtube.com/shorts/u-8KpXcPYCw')
    assert.strictEqual(channel.name, 'ycombinator')
    assert.strictEqual(calls.length, 2)
  })

  test('input that is not a YouTube link is a 400 with a clear message', async () => {
    await assert.rejects(resolveChannel('https://youtube.com/@name%'), (err) => err instanceof ChannelInputError && err.status === 400)
    await assert.rejects(resolveChannel('https://vimeo.com/123'), (err) => {
      assert.ok(err instanceof ChannelInputError)
      assert.strictEqual(err.status, 400)
      assert.match(err.message, /YouTube channel or video link/)
      return true
    })
  })

  test('a channel YouTube does not know is a 404 with a clear message', async () => {
    setYoutubeDeps({ runYtDlp: async () => { throw new Error('ERROR: [youtube:tab] @nope: This channel does not exist') } })
    await assert.rejects(resolveChannel('@nope_nope_nope'), (err) => {
      assert.ok(err instanceof ChannelInputError)
      assert.strictEqual(err.status, 404)
      assert.match(err.message, /Could not find/)
      return true
    })
  })
})
