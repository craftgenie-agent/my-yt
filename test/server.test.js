import os from 'os'
import path from 'path'
import { test, describe } from 'node:test'
import fs from 'fs'
import assert from 'assert'
import { createServer } from '../server/http.js'
import { initRepository, resetForTesting } from '../server/service-container.js'
import { setYoutubeDeps, resetYoutubeDeps } from '../lib/youtube.js'

const VERITASIUM_ID = 'UCHnyfMqiRRG1u-2MsSQLbXA'
const day = 24 * 60 * 60 * 1000

// yt-dlp and YouTube, faked: veritasium has two videos, other handles do not exist.
function fakeYtDlp (args) {
  const url = args[args.length - 1]
  if (url !== 'https://www.youtube.com/@veritasium/videos') {
    return Promise.reject(new Error('ERROR: [youtube:tab] This channel does not exist'))
  }
  const entry = (id, ageDays) => ({ _type: 'url', id, url: `https://www.youtube.com/watch?v=${id}`, title: `Video ${id}`, duration: 600, view_count: 10, timestamp: Math.floor((Date.now() - ageDays * day) / 1000) })
  return Promise.resolve(JSON.stringify({
    _type: 'playlist',
    channel: 'Veritasium',
    channel_id: VERITASIUM_ID,
    uploader_id: '@veritasium',
    entries: [entry('vid00000001', 1), entry('vid00000002', 2)]
  }))
}
async function fakeFetch (url) {
  url = String(url)
  if (url.startsWith('https://www.youtube.com/oembed?')) {
    return { ok: true, status: 200, json: async () => ({ author_name: 'Veritasium', author_url: 'https://www.youtube.com/@veritasium' }) }
  }
  return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) }
}

const serverTestDir = path.join(os.tmpdir(), 'my-yt-server-test')
const state = {}
const connections = []

test.beforeEach(() => {
  const topDir = path.join(os.tmpdir(), 'my-yt-top-test')
  resetForTesting(topDir)
  if (fs.existsSync(topDir)) {
    fs.rmSync(topDir, { recursive: true })
  }
  initRepository(topDir)
})

test('starts server', async () => {
  const server = createServer({ state, connections })
  await new Promise(resolve => server.listen(3001, resolve))
  assert.equal(server.address().port, 3001)
  await new Promise(resolve => server.close(resolve))
})

describe('server - user flow', () => {
  let server
  test.before((cb) => {
    resetForTesting(serverTestDir)
    if (fs.existsSync(serverTestDir)) {
      fs.rmSync(serverTestDir, { recursive: true })
    }
    initRepository(serverTestDir)
    setYoutubeDeps({ runYtDlp: fakeYtDlp, fetch: fakeFetch })
    server = createServer({ state, connections })
    server.listen(3001, cb)
    console.log('listening server')
  }, { timeout: 10000 })

  test.after((cb) => {
    resetYoutubeDeps()
    server.close(cb)
    console.log('closed server')
  }, { timeout: 10000 })

  test('get channels', { timeout: 5000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/channels')
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(data, [])
  })

  const veritasium = { name: 'veritasium', displayName: 'Veritasium', channelId: VERITASIUM_ID }

  test('add channel from a pasted link', { timeout: 10000 }, async () => {
    const resAddChannel = await fetch('http://0.0.0.0:3001/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        name: 'https://www.youtube.com/@veritasium/featured?si=abc'
      })
    })
    assert.equal(resAddChannel.status, 201)
    const body = await resAddChannel.json()
    assert.deepEqual(body.channel, veritasium)
    assert.equal(body.videoCount, 2)
    assert.match(body.message, /Veritasium/)

    const res = await fetch('http://0.0.0.0:3001/api/channels')
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(data, [veritasium])
  })

  test('the same channel from a video link is a 409', { timeout: 10000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'https://youtu.be/vid00000001' })
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /already/)
  })

  test('not a YouTube link is a 400 with a message', { timeout: 5000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'https://vimeo.com/123' })
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.match(body.error, /YouTube channel or video link/)
  })

  test('an unknown channel is a 404 with a message', { timeout: 5000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: '@no_such_channel_xyz' })
    })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /Could not find/)
  })

  test('get channels again', { timeout: 5000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/channels')
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(data, [veritasium])
  })

  test('get videos', { timeout: 5000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/videos')
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.ok(data.length > 0)
  })

  test('delete channel', { timeout: 5000 }, async () => {
    const resDeleteChannel = await fetch('http://0.0.0.0:3001/api/channels', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'veritasium' })
    })
    assert.equal(resDeleteChannel.status, 200)
    const resGetChannels = await fetch('http://0.0.0.0:3001/api/channels')
    const dataGetChannels = await resGetChannels.json()
    assert.equal(resGetChannels.status, 200)
    assert.deepEqual(dataGetChannels, [])
  })

  test('get videos again', { timeout: 5000 }, async () => {
    const res = await fetch('http://0.0.0.0:3001/api/videos')
    const data = await res.json()
    assert.equal(res.status, 200)
    assert.ok(data.length > 0)
  })
})
