/* global describe, it, afterEach, Response, CustomEvent */
import sinon from 'sinon'
import { fixture, html, assert, waitUntil } from '@open-wc/testing'

import '../components/forms/add-channel-form.js'
import { ENDPOINTS } from '../lib/api.js'

function jsonResponse (status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function submit (el, value) {
  el.querySelector('input').value = value
  el.querySelector('form').dispatchEvent(new CustomEvent('submit', { cancelable: true }))
}

describe('add-channel-form', () => {
  afterEach(() => sinon.restore())

  it('asks for any YouTube link', async () => {
    const el = await fixture(html`<add-channel-form></add-channel-form>`)
    assert.equal(el.querySelector('input').placeholder, 'Paste a YouTube channel or video link')
  })

  it('shows a fetching state, then the channel name and the video count', async () => {
    let finish
    const stub = sinon.stub(window, 'fetch').returns(new Promise(resolve => { finish = resolve }))
    const changed = sinon.spy()
    window.addEventListener('channels-changed', changed)

    const el = await fixture(html`<add-channel-form></add-channel-form>`)
    await submit(el, 'https://www.youtube.com/@ycombinator')

    assert.equal(stub.args[0][0], ENDPOINTS.CHANNELS)
    assert.deepEqual(JSON.parse(stub.args[0][1].body), { name: 'https://www.youtube.com/@ycombinator' })
    assert.match(el.querySelector('.status').innerText, /Fetching/)
    assert.isTrue(el.querySelector('input').disabled)

    finish(jsonResponse(201, {
      message: 'Added Y Combinator',
      channel: { name: 'ycombinator', displayName: 'Y Combinator' },
      videoCount: 30
    }))
    await waitUntil(() => !el.querySelector('input').disabled)

    const status = el.querySelector('.status').innerText
    assert.include(status, 'Y Combinator')
    assert.include(status, '30')
    assert.isFalse(el.querySelector('.status').classList.contains('error'))
    assert.equal(el.querySelector('input').value, '')
    assert.equal(changed.callCount, 1)
    window.removeEventListener('channels-changed', changed)
  })

  it('shows the error from the server and keeps the input', async () => {
    sinon.stub(window, 'fetch').resolves(jsonResponse(400, { error: 'That is not a YouTube channel or video link.' }))
    const el = await fixture(html`<add-channel-form></add-channel-form>`)
    await submit(el, 'https://vimeo.com/1')
    await waitUntil(() => !el.querySelector('input').disabled)

    const $status = el.querySelector('.status')
    assert.equal($status.innerText, 'That is not a YouTube channel or video link.')
    assert.isTrue($status.classList.contains('error'))
    assert.equal(el.querySelector('input').value, 'https://vimeo.com/1')
  })

  it('shows a clear message when the server cannot be reached', async () => {
    sinon.stub(window, 'fetch').rejects(new TypeError('Failed to fetch'))
    const el = await fixture(html`<add-channel-form></add-channel-form>`)
    await submit(el, '@ycombinator')
    await waitUntil(() => !el.querySelector('input').disabled)
    assert.match(el.querySelector('.status').innerText, /Could not add/)
  })
})
