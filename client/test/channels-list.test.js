/* global describe, it */
import { fixture, html, assert } from '@open-wc/testing'

import '../components/channels-list.js'

describe('channels-list', () => {
  it('no channels shown', async () => {
    const el = await fixture(html`
      <channels-list></channels-list>
    `)

    assert.isNull(el.querySelector('[data-channel]'))
  })

  it('channels shown', async () => {
    const el = await fixture(html`
      <channels-list data-list='["channel1"]'></channels-list>
    `)

    assert.include(el.innerHTML, 'channel1')
  })

  it('clicking on channel sets search input value to channel name', async () => {
    const el = await fixture(html`
      <div>
        <channels-list data-list='["channel1"]'></channels-list>
        <input id="search" type="text">
      </div>
    `)
    const search = el.querySelector('#search')
    const channel = el.querySelector('[data-channel="channel1"]')
    channel.click()

    assert.equal(search.value, '@channel1')
  })

  it('shows the display name and filters by the stored name', async () => {
    const el = await fixture(html`
      <div>
        <channels-list data-list='[{"name":"ycombinator","displayName":"Y Combinator"}]'></channels-list>
        <input id="search" type="text">
      </div>
    `)
    const channel = el.querySelector('[data-channel="ycombinator"]')
    assert.equal(channel.textContent.trim(), 'Y Combinator')
    channel.click()
    assert.equal(el.querySelector('#search').value, '@ycombinator')
  })
})
