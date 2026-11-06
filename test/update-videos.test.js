import os from 'os'
import path from 'path'
import fs from 'fs'
import { test, describe, afterEach } from 'node:test'
import assert from 'assert'
import { initRepository, resetForTesting } from '../server/service-container.js'
import { setYoutubeDeps, resetYoutubeDeps } from '../lib/youtube.js'
import { updateAndPersistVideos } from '../lib/update-videos.js'

const UCID = 'UCcefcZRL2oaA_uBNeo5UOWg'
const testDir = path.join(os.tmpdir(), 'my-yt-update-videos-test')

function freshRepo (channels) {
  resetForTesting(testDir)
  fs.rmSync(testDir, { recursive: true, force: true })
  fs.mkdirSync(testDir, { recursive: true })
  fs.writeFileSync(path.join(testDir, 'channels.json'), JSON.stringify(channels))
  return initRepository(testDir)
}

const ycPlaylist = JSON.stringify({
  _type: 'playlist',
  channel: 'Y Combinator',
  channel_id: UCID,
  uploader_id: '@ycombinator',
  entries: [{ _type: 'url', id: 'u-8KpXcPYCw', url: 'https://www.youtube.com/watch?v=u-8KpXcPYCw', title: 'T', duration: 60, timestamp: Math.floor(Date.now() / 1000) - 3600 }]
})

describe('updateAndPersistVideos', () => {
  afterEach(() => { resetYoutubeDeps(); resetForTesting(testDir) })

  test('fills in the display name of old channels', async () => {
    const repo = freshRepo([{ name: 'ycombinator' }])
    setYoutubeDeps({ runYtDlp: async () => ycPlaylist, fetch: async () => ({ ok: false, status: 404 }) })
    await updateAndPersistVideos()
    assert.deepEqual(repo.getChannels(), [{ name: 'ycombinator', displayName: 'Y Combinator', channelId: UCID }])
    assert.equal(repo.getVideo('u-8KpXcPYCw').channelName, 'ycombinator')
  })

  test('fixes a stored video link by asking YouTube', async () => {
    const repo = freshRepo([{ name: 'https://youtu.be/u-8KpXcPYCw' }])
    setYoutubeDeps({
      runYtDlp: async () => ycPlaylist,
      fetch: async (url) => String(url).startsWith('https://www.youtube.com/oembed?')
        ? { ok: true, status: 200, json: async () => ({ author_name: 'Y Combinator', author_url: 'https://www.youtube.com/@ycombinator' }) }
        : { ok: false, status: 404 }
    })
    await updateAndPersistVideos()
    assert.deepEqual(repo.getChannels().map(c => c.name), ['ycombinator'])
    assert.ok(repo.getVideo('u-8KpXcPYCw'))
  })
})
