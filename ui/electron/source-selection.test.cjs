
const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const {_electron} = require('playwright-core')

const data = process.env.REVIEW_CODING_DATA

test('opening and reopening source preserves the actual evidence line of decorated main', {
  skip: !data && 'Set REVIEW_CODING_DATA to a copied database containing analyzed rembg.',
  timeout: 45000
}, async () => {
  const desktop = await _electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: {...process.env, REVIEW_CODING_DATA: path.resolve(data)}, timeout: 25000
  })
  try {
    const main = await desktop.firstWindow()
    await main.getByRole('heading', {name: 'Review-Coding', exact: true}).waitFor()
    const origin = new URL(main.url()).origin
    const projects = await fetch(origin + '/api/projects').then(response => response.json())
    const project = projects.find(project => path.basename(project.root) === '97_rembg')
    assert.ok(project, 'A rembg snapshot is required.')
    const graph = await fetch(origin + '/api/snapshot?' +
      new URLSearchParams({revision: project.id, view: 'graph'})).then(response => response.json())
    const unit = Object.values(graph.units).find(unit =>
      unit.name === 'main' && unit.file === 'rembg/cli.py' && unit.kind === 'function')
    assert.ok(unit)
    assert.equal(unit.line, 28)
    const identity = {root: project.root, revision: project.id, profile: graph.profile, unit: unit.id}
    const pending = desktop.waitForEvent('window')
    await main.evaluate(identity => window.reviewDesktop.openDetail(identity), identity)
    const detail = await pending
    await detail.getByRole('button', {name: '원본 L31', exact: true}).waitFor()

    const highlighted = () => detail.locator('.detail-source .evidence-line > span')
      .allTextContents().then(values => values.map(Number))
    await detail.getByRole('button', {name: '원본 펼치기', exact: true}).click()
    assert.deepEqual(await highlighted(), [31])
    assert.equal((await detail.locator('.evidence-line code').textContent()).trim(), 'pass')

    await detail.getByRole('button', {name: '원본 접기', exact: true}).click()
    assert.equal(await detail.locator('.detail-source').count(), 0)
    await detail.getByRole('button', {name: '원본 펼치기', exact: true}).click()
    assert.deepEqual(await highlighted(), [31])

    await detail.getByRole('button', {name: '원본 접기', exact: true}).click()
    await detail.getByRole('button', {name: '원본 L31', exact: true}).click()
    assert.deepEqual(await highlighted(), [31])
    await detail.getByRole('button', {name: '원본 접기', exact: true}).click()
    await detail.getByRole('button', {name: '원본 펼치기', exact: true}).click()
    assert.deepEqual(await highlighted(), [31])

    if (process.env.REVIEW_CODING_SCREENSHOTS) {
      await detail.screenshot({path: path.join(process.env.REVIEW_CODING_SCREENSHOTS, 'main-evidence-L31.png')})
    }
  } finally {
    await desktop.close()
  }
})
