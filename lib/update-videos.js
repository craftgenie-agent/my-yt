import { getChannelVideos } from './youtube.js'
import { getRepository } from '../server/service-container.js'
import { ScraperError } from './scraper-errors.js'
import { canonicalChannelName, resolveChannel } from './channel-input.js'

export async function updateAndPersistVideos (callback = () => {}) {
  const repo = getRepository()
  await fixStoredChannelLinks(repo)
  const channels = [...repo.getChannels()]
  for (const channel of channels) {
    await updateAndPersistVideosForChannel(channel.name, callback)
  }
}

// Stored names that are still video or /c/ links (old versions stored what was typed).
// Ask YouTube which channel they are. If it cannot tell, keep the name as it is.
async function fixStoredChannelLinks (repo) {
  for (const channel of [...repo.getChannels()]) {
    if (canonicalChannelName(channel.name) === channel.name) continue
    try {
      const resolved = await resolveChannel(channel.name)
      console.log(`[update] Stored channel "${channel.name}" is now "${resolved.name}"`)
      repo.renameChannel(channel.name, resolved)
    } catch (error) {
      console.error(`[update] Could not fix the stored channel "${channel.name}": ${error.message}`)
    }
  }
}

export async function updateAndPersistVideosForChannel (name, callback = () => {}) {
  const repo = getRepository()
  try {
    const result = await getChannelVideos(name)
    let videos = result.videos
    if (Array.isArray(videos)) {
      // Fill in the display name and id of channels added by older versions.
      if (repo.updateChannel && result.channel) {
        repo.updateChannel(name, { displayName: result.channel.displayName, channelId: result.channel.channelId })
      }
      videos = videos.map(v => repo.patchVideo(v))
      repo.upsertVideos(videos)
      videos = videos
        .filter(v => !v.ignored)
        .filter(v => repo.filterByExcludedTerms(v))
      callback(null, { name, videos })
    }
    return videos
  } catch (error) {
    if (error instanceof ScraperError) {
      console.error(`[update] Failed updating @${name}: ${error.message}`)
      callback(null, { type: 'update-error', channel: name, error: error.message })
      return // Don't fail the entire batch for one channel
    }
    throw error // Non-scraper errors still propagate
  }
}
