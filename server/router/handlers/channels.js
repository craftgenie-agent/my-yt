import { updateAndPersistVideosForChannel } from '../../../lib/update-videos.js'
import { broadcastMessage, parseBody } from '../_helpers.js'
import { getRepository } from '../../service-container.js'
import { resolveChannel, ChannelInputError } from '../../../lib/channel-input.js'

export function getChannelHandler (req, res, connections = [], state = {}) {
  const repo = getRepository()
  const channels = repo.getChannels()
  res.writeHead(200, { 'Content-Type': 'application/json' })
  return res.end(JSON.stringify(channels))
}

export async function addChannelHandler (req, res, connections = []) {
  try {
    return await addChannel(req, res, connections)
  } catch (error) {
    console.error('[channels] Could not add the channel:', error)
    if (!res.headersSent) return sendJson(res, 500, { error: 'Could not add this channel because of an error in the app. Check the app logs.' })
  }
}

async function addChannel (req, res, connections) {
  const repo = getRepository()
  const parsed = await parseBody(req, res)
  if (parsed === null) return
  const input = typeof parsed.name === 'string' ? parsed.name.trim() : ''

  let channel
  try {
    channel = await resolveChannel(input)
  } catch (error) {
    if (!(error instanceof ChannelInputError)) throw error
    return sendJson(res, error.status, { error: error.message })
  }

  const existing = repo.findChannel(channel.name) || (channel.channelId && repo.findChannel(channel.channelId))
  if (existing) {
    return sendJson(res, 409, { error: `Channel already added: ${existing.displayName || existing.name}`, channel: existing })
  }

  const videos = await updateAndPersistVideosForChannel(channel.name)
  if (Array.isArray(videos)) {
    repo.addChannel(channel)
    broadcastMessage('new-videos', { name: channel.name, videos }, connections)
    return sendJson(res, 201, {
      message: `Added ${channel.displayName || channel.name}`,
      channel,
      videoCount: videos.length
    })
  }

  return sendJson(res, 404, { error: `Found ${channel.displayName || channel.name}, but could not load its videos. Try again later.` })
}

function sendJson (res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  return res.end(JSON.stringify(body))
}

export async function deleteChannelHandler (req, res, connections = [], state = {}) {
  const repo = getRepository()
  const parsed = await parseBody(req, res)
  if (parsed === null) return
  let { name } = parsed
  name = name.trim()

  if (!repo.channelExists(name)) {
    res.writeHead(409, { 'Content-Type': 'text/plain' })
    return res.end('Channel does not exist')
  }

  repo.deleteChannel(name)
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  return res.end('Channel deleted')
}

export async function ignoreVideoHandler (req, res, connections = [], state = {}) {
  const repo = getRepository()
  const parsed = await parseBody(req, res)
  if (parsed === null) return
  const { id, ignore } = parsed
  const ignored = ignore ? repo.ignoreVideo(id) : repo.unignoreVideo(id)
  broadcastMessage('ignored', { videoId: id, ignored }, connections)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  return res.end(JSON.stringify(ignored))
}

export async function deleteVideoHandler (req, res, connections = [], state = {}) {
  const repo = getRepository()
  const parsed = await parseBody(req, res)
  if (parsed === null) return
  const { id } = parsed
  repo.deleteVideo(id)
  broadcastMessage('downloaded', { videoId: id, downloaded: false }, connections)
  res.writeHead(200)
  res.end()
}

export default { getChannelHandler, addChannelHandler, deleteChannelHandler, ignoreVideoHandler, deleteVideoHandler }
