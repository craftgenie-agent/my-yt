/* global HTMLElement, customElements, CustomEvent */
import { ENDPOINTS } from '../../lib/api.js'

class AddChannelForm extends HTMLElement {
  connectedCallback () {
    this.render()
  }

  disconnectedCallback () {
    this.unregisterEvents()
  }

  registerEvents () {
    this.querySelector('form').addEventListener('submit', this.addChannelHandler.bind(this))
  }

  unregisterEvents () {
    this.querySelector('form').removeEventListener('submit', this.addChannelHandler.bind(this))
  }

  render () {
    this.innerHTML = /* html */`
      <form id="add-channel-form">
        <div class="flex space-between">
          <label for="channel-name">Add a new channel</label>
          <input type="text" id="channel-name" placeholder="Paste a YouTube channel or video link" autocomplete="off" required>
          <button type="submit">Add Channel<span class="loader"></span></button>
        </div>
        <div class="status"></div>
      </form>
    `

    this.registerEvents()
  }

  addChannelHandler (event) {
    event.preventDefault()

    const form = this.querySelector('form')
    const input = form.querySelector('input')
    const button = form.querySelector('button')
    const loader = form.querySelector('.loader')
    const status = form.querySelector('.status')

    const channelInput = input.value.trim()
    if (!channelInput) return showStatus('Paste a YouTube channel or video link first.', true)

    freezeForm()
    showStatus('Fetching the channel and its latest videos…')

    return fetch(ENDPOINTS.CHANNELS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: channelInput })
    })
      .then(async (res) => {
        const text = await res.text()
        let body = {}
        try { body = JSON.parse(text) } catch { body = { error: text } }
        if (!res.ok) return showStatus(body.error || 'Could not add this channel.', true)

        const name = body.channel?.displayName || body.channel?.name || channelInput
        const handle = body.channel?.name && !body.channel.name.startsWith('UC') ? ` (@${body.channel.name})` : ''
        const count = body.videoCount ?? 0
        input.value = ''
        showStatus(`Added ${name}${handle}. ${count} ${count === 1 ? 'video' : 'videos'} from the last 6 months.`)
        window.dispatchEvent(new CustomEvent('channels-changed', { detail: body.channel }))
      })
      .catch(error => {
        console.error('Error adding channel:', error)
        showStatus('Could not add this channel: the app did not answer. Check that it is running, then try again.', true)
      })
      .finally(unfreezeForm)

    function showStatus (text, isError = false) {
      status.innerText = text
      status.classList.toggle('error', isError)
    }
    function freezeForm () {
      input.disabled = true
      button.disabled = true
      loader.classList.add('show')
    }
    function unfreezeForm () {
      input.disabled = false
      button.disabled = false
      loader.classList.remove('show')
    }
  }
}
customElements.define('add-channel-form', AddChannelForm)
